"""The client against the stdlib fake server: authorize, idempotency, retries, waiting, settle, guard, helpers."""

import asyncio
import os
import threading
import time
import unittest
from unittest import mock

from immiscible import (
    Immiscible, ImmiscibleApprovalRequiredError, ImmiscibleApprovalTimeoutError, ImmiscibleDeniedError, ImmiscibleError,
    parse_traceparent, tool_action,
)
from immiscible.testing import start_fake


def groceries(pence, domain="ocado.com"):
    return Immiscible.payment_action(pence, "GBP", domain, provenance=[{"source": "user"}])


def later(seconds, fn, *args):
    t = threading.Timer(seconds, fn, args)
    t.daemon = True
    t.start()


class Client(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = start_fake()

    @classmethod
    def tearDownClass(cls):
        cls.fake.close()

    def client(self, **kw):
        return Immiscible(self.fake.agent_key, self.fake.url, **kw)

    def last(self, path):
        return [r for r in self.fake.requests if r["path"] == path][-1]

    def test_key_required_and_read_from_the_environment(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ImmiscibleError) as e:
                Immiscible()
            self.assertEqual(e.exception.type, "missing_api_key")
        with mock.patch.dict(os.environ, {"IMMISCIBLE_AGENT_KEY": "ask_env", "IMMISCIBLE_URL": "http://example.test/"}, clear=True):
            c = Immiscible()
            self.assertEqual((c.api_key, c.base_url), ("ask_env", "http://example.test"))

    def test_authorize_allow_idempotency_header_and_trace(self):
        im = self.client()
        d = im.authorize(groceries(2500))
        self.assertTrue(d.allowed, d)
        self.assertTrue(d.receipt)
        r = self.last("/v1/actions/authorize")
        self.assertTrue(r["body"]["idempotencyKey"].startswith("idk_"))
        self.assertEqual(r["headers"]["idempotency-key"], r["body"]["idempotencyKey"])
        self.assertEqual(parse_traceparent(r["headers"]["traceparent"])["trace_id"], im.context.trace_id)
        self.assertEqual(parse_traceparent(im.context.last_server_traceparent)["trace_id"], im.context.trace_id)

    def test_caller_key_replays_the_same_action(self):
        im = self.client()
        a = dict(groceries(300, "tesco.com"), idempotencyKey="order-py-42")
        x, y = im.authorize(a), im.authorize(a)
        self.assertEqual(x.id, y.id)
        self.assertTrue(y.get("idempotentReplay"))
        self.assertEqual(im.authorize(groceries(300, "tesco.com"), idempotency_key="order-py-42").id, x.id)

    def test_retries_503_and_dropped_connections_with_one_key(self):
        im = self.client()
        before = len(self.fake.actions)
        self.fake.fail_next("/v1/actions/authorize", 1, 503)
        self.assertTrue(im.authorize(groceries(400, "tesco.com")).allowed)
        self.fake.fail_next("/v1/actions/authorize", 1, 0)
        self.assertTrue(im.authorize(groceries(500, "tesco.com")).allowed)
        self.assertEqual(len(self.fake.actions), before + 2)

    def test_fails_closed_when_unreachable(self):
        im = Immiscible("k", "http://127.0.0.1:9", max_retries=0, timeout=2)
        with self.assertRaises(ImmiscibleError) as e:
            im.authorize(groceries(100))
        self.assertEqual(e.exception.type, "network_error")

    def test_validation_and_typed_http_errors(self):
        im = self.client()
        with self.assertRaises(TypeError):
            im.authorize({"type": "payment"})
        with self.assertRaises(ImmiscibleError) as e:
            im.authorize({"type": "payment", "summary": "x", "payment": {"amount": 64.2, "currency": "GBP", "merchant": {"domain": "ocado.com"}}})
        self.assertEqual((e.exception.status, e.exception.type), (400, "invalid_request"))
        self.assertTrue(e.exception.traceparent)
        with self.assertRaises(ImmiscibleError) as e:
            Immiscible("wrong", self.fake.url).authorize(groceries(100))
        self.assertEqual((e.exception.status, e.exception.type), (401, "invalid_api_key"))

    def test_deny_is_a_result_and_guard_never_runs(self):
        im = self.client()
        self.assertTrue(im.authorize(groceries(4999, "0cado.com")).denied)
        ran = []
        with self.assertRaises(ImmiscibleDeniedError) as e:
            with im.guard(groceries(4999, "0cado.com")):
                ran.append(1)
        self.assertEqual(ran, [])
        self.assertTrue(any(s["id"] == "lookalike_domain" for s in e.exception.signals))

    def test_wait_for_decision_backs_off_and_returns_the_approval(self):
        im = self.client()
        d = im.authorize(groceries(9500))
        self.assertTrue(d.needs_approval)
        self.assertIn("/app/approvals/apr_", d.approval_url)
        later(0.4, self.fake.approve, d.id)
        polls = []
        final = im.wait_for_decision(d.id, initial_delay=0.02, factor=2, max_delay=1, on_poll=lambda _d: polls.append(time.monotonic()))
        self.assertTrue(final.allowed)
        self.assertTrue(final.human)
        self.assertTrue(2 <= len(polls) <= 8, len(polls))
        gaps = [b - a for a, b in zip(polls, polls[1:])]
        self.assertGreater(gaps[-1], gaps[0])

    def test_a_refusal_timeout_and_cancel(self):
        im = self.client()
        d = im.authorize(groceries(9000))
        later(0.05, self.fake.deny, d.id, "not this week")
        self.assertEqual(im.wait_for_decision(d.id, initial_delay=0.01).reasons, ["not this week"])
        d2 = im.authorize(groceries(9100))
        with self.assertRaises(ImmiscibleApprovalTimeoutError) as e:
            im.wait_for_decision(d2.id, timeout=0.08, initial_delay=0.01)
        self.assertIn("waiting at http", str(e.exception))
        cancel = threading.Event()
        later(0.05, cancel.set)
        with self.assertRaises(ImmiscibleError) as e:
            im.wait_for_decision(d2.id, initial_delay=10, cancel=cancel)
        self.assertEqual(e.exception.type, "cancelled")

    def test_guard_waits_runs_and_settles(self):
        im = self.client()
        with im.guard(groceries(9200), initial_delay=0.01, on_approval_required=lambda d: later(0.03, self.fake.approve, d.id)) as d:
            self.assertTrue(d.human)
        s = [x for x in self.fake.settlements if x["actionId"] == d.id][0]
        self.assertEqual((s["status"], s["amount"]), ("completed", 9200))
        with self.assertRaises(ImmiscibleApprovalRequiredError):
            with im.guard(groceries(9300), wait=False):
                pass

    def test_guard_failure_settles_failed_and_decorator_settle_amount(self):
        im = self.client()
        with self.assertRaises(RuntimeError):
            with im.guard(groceries(1000, "tesco.com")) as d:
                raise RuntimeError("checkout broke")
        self.assertEqual([x for x in self.fake.settlements if x["actionId"] == d.id][0]["status"], "failed")

        @im.guard(lambda pence: groceries(pence, "tesco.com"), settle_amount=lambda r: r["charged"])
        def buy(pence):
            return {"charged": pence - 50}

        self.assertEqual(buy(1000), {"charged": 950})
        self.assertEqual(self.fake.settlements[-1]["amount"], 950)

    def test_guard_decorator_on_async_functions(self):
        im = self.client()

        @im.guard(lambda pence: groceries(pence, "tesco.com"))
        async def buy(pence):
            await asyncio.sleep(0)
            return pence

        self.assertEqual(asyncio.run(buy(700)), 700)
        self.assertEqual(self.fake.settlements[-1]["status"], "completed")

    def test_settle_typed_errors(self):
        im = self.client()
        d = im.authorize(groceries(700, "tesco.com"))
        self.assertEqual(im.settle(d.id, "completed", 700)["settlement"]["status"], "completed")
        with self.assertRaises(ImmiscibleError) as e:
            im.settle(d.id)
        self.assertEqual((e.exception.status, e.exception.type), (409, "already_settled"))
        with self.assertRaises(TypeError):
            im.settle(d.id, "done")
        with self.assertRaises(TypeError):
            im.settle(d.id, amount=1.5)

    def test_pay_request_data_and_tool_action(self):
        im = self.client()
        d = im.pay(6420, "gbp", "https://www.Ocado.com/basket", provenance=[{"source": "user"}])
        self.assertTrue(d.allowed)
        body = self.last("/v1/actions/authorize")["body"]
        self.assertEqual(body["payment"], {"amount": 6420, "currency": "GBP", "merchant": {"domain": "ocado.com"}})
        self.assertIn("£64.20 to ocado.com", body["summary"])
        data = im.request_data(["address"], "ocado.com", "delivery", provenance=[{"source": "user"}])
        self.assertEqual(data.released["address"], "1 Example Street, London")
        a = tool_action("fetch_page", {"url": "https://www.Example.com/x"})
        self.assertEqual((a["type"], a["target"]), ("tool.call", {"domain": "example.com"}))
        self.assertTrue(a["summary"].startswith('fetch_page: {"url"'))
        with self.assertRaises(TypeError):
            Immiscible.payment_action(64.2, "GBP", "x.com")

    def test_outcome(self):
        im = self.client()
        im.outcome("task-1", "accepted", value=3)
        self.assertEqual(self.fake.outcomes[-1], {"taskId": "task-1", "status": "accepted", "value": 3})
        with self.assertRaises(TypeError):
            im.outcome("task-1", "great")


if __name__ == "__main__":
    unittest.main()
