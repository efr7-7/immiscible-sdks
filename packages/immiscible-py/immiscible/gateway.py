"""Point model SDKs at the Immiscible gateway, inside a run.

The gateway speaks OpenAI Chat Completions at `<base>/v1/chat/completions`
and Anthropic Messages at `<base>/anthropic/v1/messages`. Adoption is a base
URL and a key; to carry the run's trace (a fresh span per call) and session,
give the SDK an httpx client with the run's event hooks::

    import httpx
    from openai import OpenAI
    run = immiscible.run()
    openai = OpenAI(**run.gateway.openai(), http_client=httpx.Client(event_hooks=run.context.httpx_event_hooks()))

or let the SDK build it: `run.gateway.openai_client()` (needs `openai` installed).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

__all__ = ["Gateway"]


class Gateway:
    def __init__(self, client):
        self._client = client

    @property
    def base_url(self) -> str:
        return self._client.base_url

    def _static(self, task_id: Optional[str], task_class: Optional[str], objective: Optional[str], headers: Optional[Dict[str, str]]) -> Dict[str, str]:
        h = dict(headers or {})
        if task_id:
            h["x-immiscible-task-id"] = task_id
        if task_class:
            h["x-immiscible-task-class"] = task_class
        if objective:
            h["x-immiscible-objective"] = objective
        return h

    def openai(self, *, api_key: Optional[str] = None, task_id: Optional[str] = None, task_class: Optional[str] = None,
               objective: Optional[str] = None, headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        """Keyword arguments for `OpenAI(...)` / `AsyncOpenAI(...)`: Chat Completions through the gateway."""
        return {"base_url": f"{self.base_url}/v1", "api_key": api_key or self._client.api_key,
                "default_headers": self._static(task_id, task_class, objective, headers)}

    def anthropic(self, *, api_key: Optional[str] = None, task_id: Optional[str] = None, task_class: Optional[str] = None,
                  objective: Optional[str] = None, headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        """Keyword arguments for `Anthropic(...)` / `AsyncAnthropic(...)`: Messages through the gateway."""
        return {"base_url": f"{self.base_url}/anthropic", "api_key": api_key or self._client.api_key,
                "default_headers": self._static(task_id, task_class, objective, headers)}

    def openai_client(self, *, async_: bool = False, **kwargs):
        """An OpenAI (or AsyncOpenAI) client through the gateway, carrying the run. Needs `openai` (and its httpx)."""
        try:
            import httpx
            import openai
        except ImportError as e:  # pragma: no cover - depends on what is installed
            raise ImportError("openai_client needs the openai package: pip install openai") from e
        opts = self.openai(**kwargs)
        hooks = self._client.context.httpx_event_hooks(async_=async_)
        if async_:
            return openai.AsyncOpenAI(**opts, http_client=httpx.AsyncClient(event_hooks=hooks))
        return openai.OpenAI(**opts, http_client=httpx.Client(event_hooks=hooks))

    def anthropic_client(self, *, async_: bool = False, **kwargs):
        """An Anthropic (or AsyncAnthropic) client through the gateway, carrying the run. Needs `anthropic`."""
        try:
            import anthropic
            import httpx
        except ImportError as e:  # pragma: no cover
            raise ImportError("anthropic_client needs the anthropic package: pip install anthropic") from e
        opts = self.anthropic(**kwargs)
        hooks = self._client.context.httpx_event_hooks(async_=async_)
        if async_:
            return anthropic.AsyncAnthropic(**opts, http_client=httpx.AsyncClient(event_hooks=hooks))
        return anthropic.Anthropic(**opts, http_client=httpx.Client(event_hooks=hooks))

    def env(self, *, api_key: Optional[str] = None) -> Dict[str, str]:
        """Environment for a child process that reads the standard variables (Claude Code, CLIs)."""
        key = api_key or self._client.api_key
        out = {
            "OPENAI_BASE_URL": f"{self.base_url}/v1", "OPENAI_API_KEY": key,
            "ANTHROPIC_BASE_URL": f"{self.base_url}/anthropic", "ANTHROPIC_API_KEY": key,
            "IMMISCIBLE_URL": self.base_url, "TRACEPARENT": self._client.context.traceparent(),
        }
        if self._client.context.session_id:
            out["IMMISCIBLE_SESSION"] = self._client.context.session_id
        return out
