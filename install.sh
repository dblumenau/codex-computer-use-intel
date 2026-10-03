#!/usr/bin/env bash
#
# Installer for the computer-use-intel Codex plugin (x86_64 / Intel macOS).
#
# What it does:
#   1. Builds the MCP server (TypeScript -> dist/server.js) and the native
#      Swift helpers (Vision OCR, Accessibility, CGEvent) if a working Xcode
#      `swiftc` is present; otherwise falls back to the prebuilt x86_64 binaries
#      shipped in computer-use-intel/prebuilt/.
#   2. Generates marketplace/plugins/computer-use-intel/.mcp.json with the
#      correct absolute paths for THIS machine.
#   3. Prints (or with --write-config, appends) the ~/.codex/config.toml entries
#      that register the local marketplace and enable the plugin.
#
# Usage:
#   ./install.sh                 # build + generate .mcp.json + print config snippet
#   ./install.sh --write-config  # also append the entries to ~/.codex/config.toml
#   ./install.sh --help
#
set -euo pipefail

# --- locate ourselves -------------------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/computer-use-intel"
PLUGIN_DIR="$ROOT/marketplace/plugins/computer-use-intel"
MARKETPLACE_DIR="$ROOT/marketplace"

MARKETPLACE_NAME="codexintel-local"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
WRITE_CONFIG=0

while [ $# -gt 0 ]; do
  case "$1" in
    --write-config) WRITE_CONFIG=1 ;;
    --marketplace-name) MARKETPLACE_NAME="$2"; shift ;;
    --codex-home) CODEX_HOME="$2"; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- preconditions ----------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "macOS only."
if [ "$(uname -m)" != "x86_64" ]; then
  warn "This Mac is $(uname -m), not x86_64. This package targets Intel Macs; on Apple Silicon use the official Computer Use plugin instead. Continuing anyway."
fi

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node not found on PATH. Install Node.js (e.g. 'brew install node') and re-run."
command -v npm >/dev/null 2>&1 || die "npm not found on PATH."
say "Using node: $NODE_BIN ($("$NODE_BIN" -v))"

if ! command -v cliclick >/dev/null 2>&1; then
  warn "cliclick not found. Mouse/keyboard tools need it: 'brew install cliclick'."
fi

# --- build the MCP server ---------------------------------------------------
say "Installing npm dependencies in $SERVER_DIR ..."
( cd "$SERVER_DIR" && { npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund; } )

say "Building TypeScript ..."
( cd "$SERVER_DIR" && ./node_modules/.bin/tsc ) || die "TypeScript build failed; installation stopped."

# Old helpers do not implement newly added commands. A failed rebuild must use
# this release's prebuilt helper, never silently retain an older executable.
rm -f "$SERVER_DIR/dist/vision-ocr" "$SERVER_DIR/dist/ax-helper" "$SERVER_DIR/dist/cgevent" "$SERVER_DIR/dist/activity-overlay"
say "Building native Swift helpers (prebuilt fallback available) ..."
( cd "$SERVER_DIR" && npm run build:ocr && npm run build:ax && npm run build:cg && npm run build:overlay ) || warn "Native build reported errors; will use prebuilt helpers below."

[ -f "$SERVER_DIR/dist/server.js" ] || die "dist/server.js was not produced. Check the npm build output above."

# --- ensure native binaries (use prebuilt fallback when build skipped one) --
ensure_bin() {
  local name="$1"
  local built="$SERVER_DIR/dist/$name"
  local pre="$SERVER_DIR/prebuilt/$name"
  if [ -x "$built" ]; then
    say "native helper '$name': freshly built."
    return
  fi
  if [ -f "$pre" ]; then
    say "native helper '$name': using prebuilt x86_64 binary."
    cp "$pre" "$built"
    chmod +x "$built"
    xattr -dr com.apple.quarantine "$built" 2>/dev/null || true
  else
    warn "native helper '$name' missing and no prebuilt fallback; related tools will be unavailable."
  fi
}
ensure_bin vision-ocr
ensure_bin ax-helper
ensure_bin cgevent
ensure_bin activity-overlay
[ -x "$SERVER_DIR/dist/ax-helper" ] || die "ax-helper is required for v1.3 app identity and verification."
[ -x "$SERVER_DIR/dist/cgevent" ] || die "cgevent is required for v1.3 screenshot geometry."

# --- generate machine-specific .mcp.json ------------------------------------
SERVER_JS="$SERVER_DIR/dist/server.js"
TEMPLATE="$PLUGIN_DIR/.mcp.json.example"
TARGET="$PLUGIN_DIR/.mcp.json"
[ -f "$TEMPLATE" ] || die "Missing template: $TEMPLATE"

# Use python3 for safe JSON string substitution (paths may contain spaces).
/usr/bin/python3 - "$TEMPLATE" "$TARGET" "$NODE_BIN" "$SERVER_JS" <<'PY'
import json, sys
tmpl, target, node_bin, server_js = sys.argv[1:5]
with open(tmpl) as f:
    data = json.load(f)
data.pop("_comment", None)
srv = data["mcpServers"]["computer-use-intel"]
srv["command"] = node_bin
srv["args"] = [server_js]
with open(target, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"[install] wrote {target}")
PY

# --- smoke test the server --------------------------------------------------
say "Smoke-testing the MCP server ..."
if env -i PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME" \
     "$NODE_BIN" "$SERVER_JS" < /dev/null 2>&1 | grep -q "ready over stdio"; then
  say "Server starts OK."
else
  warn "Server did not print its ready line; check 'node $SERVER_JS' manually."
fi

# --- config.toml entries ----------------------------------------------------
CONFIG="$CODEX_HOME/config.toml"
read -r -d '' SNIPPET <<EOF || true
# --- computer-use-intel (local plugin) ---
[plugins."computer-use@openai-bundled"]
enabled = false

[marketplaces.$MARKETPLACE_NAME]
last_updated = "1970-01-01T00:00:00Z"
source_type = "local"
source = "$MARKETPLACE_DIR"

[plugins."computer-use-intel@$MARKETPLACE_NAME"]
enabled = true
EOF

if [ "$WRITE_CONFIG" = "1" ]; then
  [ -f "$CONFIG" ] || { mkdir -p "$CODEX_HOME"; : > "$CONFIG"; }
  cp "$CONFIG" "$CONFIG.bak.$(date +%Y%m%d-%H%M%S)-pre-cui-install"
  added=0
  if ! grep -q "^\[marketplaces.$MARKETPLACE_NAME\]" "$CONFIG"; then
    printf '\n%s\n' "$SNIPPET" >> "$CONFIG"; added=1
  fi
  if [ "$added" = "1" ]; then
    say "Appended marketplace + plugin entries to $CONFIG (backup created)."
  else
    say "Marketplace '$MARKETPLACE_NAME' already present in $CONFIG; left it unchanged."
  fi
else
  echo
  say "Add the following to $CONFIG (under [features] keep apps = true, plugins = true):"
  echo "----------------------------------------------------------------------"
  echo "$SNIPPET"
  echo "----------------------------------------------------------------------"
fi

cat <<EOF

$(say "Done.")
Next steps:
  1. Ensure ~/.codex/config.toml has [features] apps = true and plugins = true.
  2. Grant macOS permissions to the Codex app:
       System Settings -> Privacy & Security -> Accessibility   (add Codex)
       System Settings -> Privacy & Security -> Screen Recording (add Codex)
  3. Fully quit Codex (Cmd+Q) and relaunch.
  4. Settings -> Plugins should list "Computer Use (Intel)"; the composer
     supports @computer-use-intel.
EOF
