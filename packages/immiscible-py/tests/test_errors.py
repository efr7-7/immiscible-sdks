"""HTTP failures arrive as the error class for their status, and the client defaults to the hosted service."""

import io
import json
import unittest
import urllib.error
from email.message import Message

from immiscible import (
    DEFAULT_BASE_URL, Immiscible, ImmiscibleAuthenticationError, ImmiscibleConnectionError, ImmiscibleError,
    ImmiscibleIdempotencyConflictError, ImmiscibleInvalidRequestError, ImmiscibleRateLimitError,
)

ACTION = {"type": "payment", "summary": "Pay for groceries"}


def answering(status, error, retry_after=None):
    def opener(req, timeout=None):
        h = Message()
        h["x-request-id"] = "req_1"
        if retry_after:
            h["retry-after"] = retry_after
        raise urllib.error.HTTPError(req.full_url, status, "error", h, io.BytesIO(json.dumps({"error": error}).encode()))
    return opener


def client(opener):
    return Immiscible("ask_test", "http://example.invalid", opener=opener, max_retries=0)


class Errors(unittest.TestCase):
    def test_classes_by_status(self):
        cases = [
            (401, {"type": "invalid_api_key", "message": "unknown key"}, ImmiscibleAuthenticationError),
            (400, {"type": "invalid_request", "message": "bad", "errors": [{"field": "type"}]}, ImmiscibleInvalidRequestError),
            (429, {"type": "rate_limited", "message": "slow down"}, ImmiscibleRateLimitError),
            (409, {"type": "idempotency_conflict", "message": "different body"}, ImmiscibleIdempotencyConflictError),
        ]
        for status, error, cls in cases:
            with self.assertRaises(cls) as ctx:
                client(answering(status, error, "7")).authorize(ACTION)
            self.assertIsInstance(ctx.exception, ImmiscibleError)
            self.assertEqual(ctx.exception.request_id, "req_1")
        with self.assertRaises(ImmiscibleInvalidRequestError) as bad:
            client(answering(400, {"type": "invalid_request", "message": "bad", "errors": [{"field": "type"}]})).authorize(ACTION)
        self.assertEqual(bad.exception.errors, [{"field": "type"}])
        with self.assertRaises(ImmiscibleRateLimitError) as slow:
            client(answering(429, {"type": "rate_limited", "message": "x"}, "7")).authorize(ACTION)
        self.assertEqual(slow.exception.retry_after, 7.0)

    def test_network_failure_is_connection_error(self):
        def down(req, timeout=None):
            raise urllib.error.URLError("refused")
        with self.assertRaises(ImmiscibleConnectionError):
            client(down).authorize(ACTION)

    def test_default_base_url_is_hosted(self):
        self.assertEqual(DEFAULT_BASE_URL, "https://immiscible.fly.dev")


if __name__ == "__main__":
    unittest.main()
