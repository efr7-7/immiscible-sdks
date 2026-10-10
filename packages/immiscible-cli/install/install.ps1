# Install the Immiscible CLI: irm https://immiscible.ai/install.ps1 | iex
# Needs Node 22.13 or later. Installs the npm package "immiscible" globally, then shows the welcome card.
# Set $env:IMMISCIBLE_VERSION to pin a version. Nothing else on the machine is changed.
$ErrorActionPreference = 'Stop'

$version = if ($env:IMMISCIBLE_VERSION) { $env:IMMISCIBLE_VERSION } else { 'latest' }

function Fail($message) {
  Write-Host "x $message" -ForegroundColor Red
  return
}

Write-Host ""
Write-Host "  Installing immiscible ($version)"
Write-Host ""

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node 22.13 or later is needed. Install it from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then run this again."
  return
}

& node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
if ($LASTEXITCODE -ne 0) {
  Fail "Node $(& node -v) is too old: Immiscible needs 22.13 or later. Update from https://nodejs.org, then run this again."
  return
}

& npm install -g "immiscible@$version" --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) {
  Fail "npm could not install globally. Try again from a new terminal, or run: npx immiscible try"
  return
}

$cli = Get-Command immiscible -ErrorAction SilentlyContinue
if ($cli) {
  & immiscible about 2>$null
  if ($LASTEXITCODE -ne 0) { & immiscible --version }
} else {
  Write-Host "Installed, but immiscible is not on your PATH yet. Open a new terminal and run: immiscible about"
}
