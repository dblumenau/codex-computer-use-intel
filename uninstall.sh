#!/usr/bin/env bash
#
# Uninstaller for the computer-use-intel Codex plugin.
#
# Removes the marketplace + plugin entries that install.sh --write-config added
# to ~/.codex/config.toml (a timestamped backup is created first) and deletes
# the generated .mcp.json. It does NOT delete this folder or re-enable the
# bundled arm64 Computer Use plugin.
#
# Usage:
#   ./uninstall.sh                 # remove the appended config block + .mcp.json
#   ./uninstall.sh --print-only    # only show what to remove, change nothing
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$ROOT/marketplace/plugins/computer-use-intel"
MARKETPLACE_NAME="codexintel-local"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$CODEX_HOME/config.toml"
PRINT_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --print-only) PRINT_ONLY=1 ;;
    --marketplace-name) MARKETPLACE_NAME="$2"; shift ;;
    --codex-home) CODEX_HOME="$2"; CONFIG="$CODEX_HOME/config.toml"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1;34m[uninstall]\033[0m %s\n' "$*"; }

if [ "$PRINT_ONLY" = "1" ]; then
  say "To uninstall, remove these tables from $CONFIG:"
  echo "  [marketplaces.$MARKETPLACE_NAME]"
  echo "  [plugins.\"computer-use-intel@$MARKETPLACE_NAME\"]"
  echo "and optionally delete: $PLUGIN_DIR/.mcp.json"
  exit 0
fi

if [ -f "$CONFIG" ]; then
  cp "$CONFIG" "$CONFIG.bak.$(date +%Y%m%d-%H%M%S)-pre-cui-uninstall"
  /usr/bin/python3 - "$CONFIG" "$MARKETPLACE_NAME" <<'PY'
import re, sys
path, name = sys.argv[1], sys.argv[2]
src = open(path).read()
# Remove the install-appended, comment-delimited block if present.
marker = "# --- computer-use-intel (local plugin) ---"
lines = src.splitlines(keepends=True)
out, i, removed = [], 0, False
def is_header(l): return l.lstrip().startswith("[")
while i < len(lines):
    if lines[i].strip() == marker:
        removed = True
        i += 1
        # skip until the plugin-enable table's body ends (blank line / next header / EOF)
        seen_plugin = False
        while i < len(lines):
            l = lines[i]
            if f'[plugins."computer-use-intel@{name}"]' in l:
                seen_plugin = True
                i += 1
                continue
            if seen_plugin and (l.strip() == "" or (is_header(l) and "computer-use-intel@" not in l and f"marketplaces.{name}" not in l)):
                break
            i += 1
        continue
    out.append(lines[i]); i += 1
if removed:
    open(path, "w").write("".join(out).rstrip() + "\n")
    print("[uninstall] removed the appended computer-use-intel block from config.toml")
else:
    print("[uninstall] no install-appended block found; remove these tables manually:")
    print(f"  [marketplaces.{name}]")
    print(f'  [plugins."computer-use-intel@{name}"]')
PY
else
  say "No config at $CONFIG; nothing to change."
fi

if [ -f "$PLUGIN_DIR/.mcp.json" ]; then
  rm -f "$PLUGIN_DIR/.mcp.json"
  say "Deleted generated $PLUGIN_DIR/.mcp.json"
fi

say "Done. Fully quit Codex (Cmd+Q) and relaunch to apply."
