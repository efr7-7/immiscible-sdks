#!/bin/sh
# Ask Immiscible before an action, over plain HTTP. Needs curl and IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY.
set -eu

# 1. Ask. The answer is allow (with a signed receipt), approval_required, or deny (with reasons).
answer=$(curl -sS -X POST "$IMMISCIBLE_URL/v1/actions/authorize" \
  -H "authorization: Bearer $IMMISCIBLE_AGENT_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: deploy-api-$(date +%s)" \
  -d '{
    "type": "tool.call",
    "summary": "Deploy the api service",
    "target": { "domain": "deploy.example" },
    "provenance": [{ "source": "user", "detail": "asked in the deploy channel" }]
  }')
echo "$answer"
id=$(printf '%s' "$answer" | sed -n 's/.*"id":"\(act_[A-Za-z0-9_]*\)".*/\1/p')

# 2. Held for a person? Ask again until they decide. Act only on "allow".
while printf '%s' "$answer" | grep -q '"decision":"approval_required"'; do
  sleep 2
  answer=$(curl -sS "$IMMISCIBLE_URL/v1/actions/$id" -H "authorization: Bearer $IMMISCIBLE_AGENT_KEY")
done
printf '%s' "$answer" | grep -q '"decision":"allow"' || { echo "not allowed: $answer"; exit 1; }
echo "allowed: $id"

# 3. ... do the work here, then say how it went.
curl -sS -X POST "$IMMISCIBLE_URL/v1/actions/$id/settle" \
  -H "authorization: Bearer $IMMISCIBLE_AGENT_KEY" \
  -H "content-type: application/json" \
  -d '{ "status": "completed" }'
echo
