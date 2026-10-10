"""immiscible: the control layer for AI agents, from the agent's side.

    from immiscible import Immiscible
    immiscible = Immiscible()                       # IMMISCIBLE_AGENT_KEY, IMMISCIBLE_URL
    run = immiscible.run()                          # one trace and one session per task
    with run.guard(action) as decision:             # authorize, wait, run, settle
        do_the_thing(decision.receipt)

Standard library only, including the Ed25519 verifier.
"""

from .client import DEFAULT_BASE_URL, SDK_VERSION, Decision, Immiscible, new_idempotency_key, normalise_domain, tool_action
from .errors import (
    ImmiscibleApprovalRequiredError, ImmiscibleApprovalTimeoutError, ImmiscibleAuthenticationError, ImmiscibleConnectionError,
    ImmiscibleDeniedError, ImmiscibleError, ImmiscibleIdempotencyConflictError, ImmiscibleInvalidRequestError, ImmiscibleRateLimitError,
    is_refusal,
)
from .gateway import Gateway
from .proxy import MCP_PROTOCOL, McpProxy, approval_from_result, approval_meta, mcp_proxy_url, mcp_server_url
from .trace import (
    ISSUED_SESSION_HEADER, SESSION_HEADER, TRACEPARENT_HEADER, RunContext, format_traceparent, is_valid_session_id,
    new_span_id, new_trace_id, parse_traceparent,
)
from .verify import (
    JWKS_PATH, REASONS, RECEIPT_TYP, VerifyResult, canonical_cart, cart_digest, clear_jwks_cache, decode_receipt_unverified,
    fetch_jwks, pin_jwks, verify_online, verify_receipt,
)

__version__ = SDK_VERSION
__all__ = [
    "Immiscible", "Decision", "tool_action", "normalise_domain", "new_idempotency_key", "DEFAULT_BASE_URL", "SDK_VERSION",
    "ImmiscibleError", "ImmiscibleDeniedError", "ImmiscibleApprovalTimeoutError", "ImmiscibleApprovalRequiredError", "is_refusal",
    "ImmiscibleAuthenticationError", "ImmiscibleInvalidRequestError", "ImmiscibleRateLimitError", "ImmiscibleIdempotencyConflictError",
    "ImmiscibleConnectionError",
    "Gateway", "McpProxy", "mcp_proxy_url", "mcp_server_url", "approval_from_result", "approval_meta", "MCP_PROTOCOL",
    "RunContext", "parse_traceparent", "format_traceparent", "new_trace_id", "new_span_id", "is_valid_session_id",
    "SESSION_HEADER", "ISSUED_SESSION_HEADER", "TRACEPARENT_HEADER",
    "verify_receipt", "verify_online", "fetch_jwks", "pin_jwks", "VerifyResult", "clear_jwks_cache", "decode_receipt_unverified",
    "cart_digest", "canonical_cart", "RECEIPT_TYP", "JWKS_PATH", "REASONS",
]
