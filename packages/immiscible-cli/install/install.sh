#!/bin/sh
# Install the Immiscible CLI: curl -fsSL https://immiscible.ai/install.sh | sh
# Needs Node 22.13 or later. Installs the npm package "immiscible" globally, then shows the welcome card.
# Set IMMISCIBLE_VERSION to pin a version. Nothing else on the machine is changed.
set -eu

VERSION="${IMMISCIBLE_VERSION:-latest}"
say() { printf '%s\n' "$*"; }
fail() { printf 'x %s\n' "$*" >&2; exit 1; }

say ""
say "  Installing immiscible ($VERSION)"
say ""

command -v node >/dev/null 2>&1 || fail "Node 22.13 or later is needed. Install it from https://nodejs.org (or: brew install node), then run this again."
command -v npm >/dev/null 2>&1 || fail "npm was not found next to Node. Reinstall Node from https://nodejs.org, then run this again."

node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || fail "Node $(node -v) is too old: Immiscible needs 22.13 or later. Update from https://nodejs.org, then run this again."

if ! npm install -g "immiscible@$VERSION" --no-fund --no-audit --loglevel=error; then
  fail "npm could not install globally. If it needs permission, set a user prefix (npm config set prefix ~/.npm-global, then add ~/.npm-global/bin to PATH) or run: npx immiscible try"
fi

if command -v immiscible >/dev/null 2>&1; then
  immiscible about 2>/dev/null || immiscible --version
else
  say "Installed, but immiscible is not on your PATH yet. Add $(npm prefix -g)/bin to PATH, or open a new terminal."
fi
