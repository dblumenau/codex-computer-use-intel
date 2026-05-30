# computer-use-intel

Drop-in **x86_64** MCP server that replaces the arm64-only `Codex Computer Use.app`
helper shipped with Codex Desktop on macOS. Lets Codex control mouse, keyboard,
screenshots, scrolling and app launches on Intel Macs where the bundled plugin
fails with `bad CPU type in executable`.

Related issues this works around:
- [openai/codex#18404](https://github.com/openai/codex/issues/18404) — Computer Use stays "unavailable" on Intel even when MCP is toggled on.
- [openai/codex#18258](https://github.com/openai/codex/issues/18258) — Bundled plugin reported unavailable, fix requires `features.apps = true`.

## Why this exists

The official Codex Desktop `Computer Use` plugin bundles two Swift helper apps:

- `SkyComputerUseService` (arm64)
- `SkyComputerUseClient` (arm64)

Both are Mach-O `arm64` only. Intel Macs have no `arm64 → x86_64` binary translator
(Rosetta 2 only runs `x86_64` on Apple Silicon, not the reverse), so the MCP server
advertised by the plugin crashes on startup.

OpenAI ships no public source for these helpers and no universal build. This project
reimplements the same tool surface as a plain Node.js (x86_64) MCP server using:

- `screencapture` (macOS built-in) — screenshots
- `cliclick` (Homebrew, universal) — mouse + basic keyboard
- `osascript` (macOS built-in) — keystrokes, app scripting
- `open` (macOS built-in) — app launching
- `pbcopy` / `pbpaste` (macOS built-in) — clipboard
- Apple **Vision** framework for on-device OCR / "find text on screen", via a
  native x86_64 Swift binary (`dist/vision-ocr`), with a PyObjC fallback
  (`src/ocr.py` in a project venv). The same binary also draws Set-of-Marks
  overlays and samples pixel colors.
- macOS **Accessibility API** for structured UI perception and deterministic
  control (read the UI element tree, press buttons/menu items, set field values,
  manage windows), via a second native x86_64 Swift binary (`dist/ax-helper`).
- **CoreGraphics CGEvent** for precise scroll-wheel events (pixel/line units,
  both axes, smooth) and arbitrary key hold/tap (not just modifiers), via a
  third native x86_64 Swift binary (`dist/cgevent`).

> **OCR backend.** Primary is a tiny native Swift binary compiled against the
> Vision framework. Building it requires the **full Xcode** toolchain — the
> standalone CommandLineTools `swiftc` on macOS 26 had an SDK/compiler version
> mismatch (`failed to build module 'Foundation' … this SDK is not supported by
> the compiler`, later `use of undeclared identifier 'LONG_MAX'` from stale
> `/usr/local/include` symlinks) and could not build Vision binaries. With Xcode
> installed and selected, `swiftc` works. If the binary is absent at runtime, the
> server transparently falls back to the PyObjC bridge. The active backend is
> reported in the startup log line (`ocr=swift` or `ocr=python`).
>
> **Accessibility backend.** The Accessibility tools (`get_ui_elements`,
> `find_element`, `click_element`, `set_element_value`, `click_menu_item`,
> window management, `wait_for_element`, `get_selected_text`) depend on the
> native `dist/ax-helper` binary, also built with Xcode's `swiftc`. If it is
> missing those tools report a clear "AX helper not built" error and the rest of
> the server keeps working; the startup log shows `ax=on` / `ax=off`.
>
> **CGEvent backend.** Precise scrolling, arbitrary key hold (`key_down`/`key_up`
> for non-modifier keys) and `key_tap` use the native `dist/cgevent` binary. When
> it is missing, `scroll` falls back to AppleScript/arrow keys, key hold is
> limited to modifiers (via cliclick), and `key_tap` is unavailable. The startup
> log shows `cg=on` / `cg=off`.

## Requirements

- macOS 12+ (tested on Sonoma 14, Sequoia 15, Tahoe 26)
- Node.js ≥ 18 (x86_64)
- `cliclick` → `brew install cliclick`
- For the OCR binary: **Xcode** (provides a consistent `swiftc` + SDK). On Intel
  Macs the standalone Command Line Tools may have a broken Swift toolchain.
- Fallback only: Python 3 (system `/usr/bin/python3`) for the PyObjC OCR venv.

## Install / build

> Tip: the top-level [`install.sh`](../install.sh) automates everything below
> (build, prebuilt-binary fallback, generating `.mcp.json`, and the
> `config.toml` snippet). Use these manual steps only if you want to build by hand.

```bash
cd codex-computer-use-intel/computer-use-intel
npm install
npm run build      # compiles TS + builds the native Swift OCR binary (dist/vision-ocr)
```

This produces `dist/server.js` (the stdio MCP entry point), `dist/vision-ocr`
(the native OCR / annotate / pixel helper), `dist/ax-helper` (the Accessibility
helper) and `dist/cgevent` (the CGEvent scroll / key-hold helper). Per-binary
rebuilds: `npm run build:ocr` (auto-falls back to `npm run build:ocr:py` PyObjC
venv if `swiftc` fails), `npm run build:ax`, `npm run build:cg`.

## Codex configuration

There are two ways to wire this up. The **plugin** option is recommended: it
restores the `@computer-use-intel` mention in the composer and survives Codex
app updates (it lives in this repo, outside the app bundle).

### Option A (recommended): local plugin with a bundled MCP server

A sibling [`marketplace/`](../marketplace) folder packages this server as a
Codex plugin:

```
marketplace/
  .agents/plugins/marketplace.json        # marketplace manifest (REQUIRED — lists the plugin)
  plugins/computer-use-intel/
    .codex-plugin/plugin.json             # name + interface (the @computer-use-intel alias)
    .mcp.json                             # bundles the MCP server (auto-discovered by Codex)
    skills/computer-use-intel/SKILL.md
```

The `.agents/plugins/marketplace.json` file is what makes Codex discover the
marketplace; without it the plugin does NOT appear in Settings -> Plugins. Its
`name` must match the `[marketplaces.<name>]` key in `config.toml`, and each
entry's `source.path` points at the plugin folder.

Register the local marketplace and enable the plugin in `~/.codex/config.toml`:

```toml
[features]
apps = true
plugins = true

# Disable the broken arm64 bundled plugin so Codex stops trying to launch it.
[plugins."computer-use@openai-bundled"]
enabled = false

[marketplaces.codexintel-local]
source_type = "local"
source = "/ABSOLUTE/PATH/TO/codex-computer-use-intel/marketplace"

[plugins."computer-use-intel@codexintel-local"]
enabled = true
```

Do NOT also add a standalone `[mcp_servers.computer-use-intel]` entry — the
plugin already provides the server via its `.mcp.json`, and registering both
would double-register the tools. Codex discovers `.mcp.json` / `mcp.json` in the
plugin root automatically.

### Option B: plain MCP server (no @ mention)

If you do not want a plugin, register the server directly instead:

```toml
[mcp_servers.computer-use-intel]
command = "/usr/local/bin/node"
args = ["/ABSOLUTE/PATH/TO/codex-computer-use-intel/computer-use-intel/dist/server.js"]
startup_timeout_sec = 15

[mcp_servers.computer-use-intel.env]
PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
```

The tools work either way; recent Codex builds only surface **plugins** (not raw
`mcp_servers`) in the `@` composer menu, which is why Option A is preferred.

Adjust the paths if your install location differs. Fully quit Codex (`Cmd+Q`,
don't just close the window) and relaunch so it picks up the changes.

## macOS permissions

On first use, Codex (the host process that spawns this MCP server) needs:

1. **Accessibility** — required for `cliclick` and `cgevent` to inject
   mouse/keyboard/scroll events **and** for all `ax-helper` tools (reading the UI
   tree, pressing buttons/menu items, window control, selected text).
   `System Settings → Privacy & Security → Accessibility` → add **Codex**.
2. **Screen Recording** — required for `screencapture` to return pixel data.
   `System Settings → Privacy & Security → Screen Recording` → add **Codex**.
3. **Automation** (prompted on first run) — `System Events`, `Finder` and any app
   you script via `osascript`.

If any tool returns an error like `assistive access is not allowed`, revisit the
Accessibility list. You may need to toggle Codex off/on once after granting
permission.

## Exposed tools (52)

### Core mouse / keyboard / screen

| Tool              | Arguments                                    | Notes                                     |
| ----------------- | -------------------------------------------- | ----------------------------------------- |
| `screenshot`      | `region?`, `display_index?`, `show_cursor?`, `max_width?` | Returns inline base64 PNG; `max_width` downscales for fewer tokens |
| `screen_size`     | —                                            | Main display, in points                   |
| `cursor_position` | —                                            | Uses cliclick, no perms needed            |
| `mouse_move`      | `x`, `y`                                     |                                           |
| `left_click`      | `x?`, `y?`                                   | Omit coords to click at current cursor    |
| `right_click`     | `x?`, `y?`                                   |                                           |
| `middle_click`    | `x?`, `y?`                                   |                                           |
| `double_click`    | `x?`, `y?`                                   |                                           |
| `left_click_drag` | `from {x,y}`, `to {x,y}`                     | Press-drag-release                        |
| `scroll`          | `direction`, `amount`, `x?`, `y?`, `pixels?`, `smooth?` | Real CGEvent wheel (both axes); `pixels`/`smooth` for fine glide; AppleScript fallback |
| `type`            | `text`, `delay_ms?`                          | Unicode safe via AppleScript keystroke    |
| `key`             | `keys`                                       | e.g. `"cmd+c"`, `"Return"`, `"arrow-up"`  |
| `wait`            | `ms`                                         | Capped at 60s                             |
| `open_app`        | `name`                                       | Name / bundle id / `.app` path            |
| `focus_app`       | `name`                                       | Activate without relaunching              |
| `list_apps`       | —                                            | Foreground processes                      |
| `frontmost_app`   | —                                            |                                           |
| `run_applescript` | `script`                                     | Escape hatch                              |
| `cliclick_raw`    | `args: string[]`                             | Passthrough for `man cliclick` power users|
| `find_text`       | `query`, `region?`, `regex?`, `case_sensitive?`, `fast?`, `lang?` | **OCR** — returns each match + clickable screen-point center |
| `click_text`      | `query`, `match_index?`, `button?`, …        | OCR a label and click it in one step      |
| `ocr_screen`      | `region?`, `fast?`, `lang?`, `include_coordinates?` | Read all on-screen text (Apple Vision)    |
| `get_clipboard`   | —                                            | `pbpaste`                                 |
| `set_clipboard`   | `text`                                       | `pbcopy` (pair with `key "cmd+v"`)        |

### Accessibility (structured UI — needs `dist/ax-helper`)

| Tool                 | Arguments                                  | Notes                                          |
| -------------------- | ------------------------------------------ | ---------------------------------------------- |
| `get_ui_elements`    | `app?`, `actionable_only?`, `max_nodes?`   | Dump the AX tree: role/title/value + clickable center. The reliable alternative to OCR |
| `find_element`       | `role?`, `title?`, `value?`, `index?`, `app?` | Search the AX tree, returns clickable centers |
| `click_element`      | matchers                                   | AXPress the matched element (coordinate-click fallback) |
| `set_element_value`  | `new_value`, `role?`, `title?`, `index?`, `app?` | Set a field value directly via AX, no typing  |
| `get_element_value`  | matchers                                   | Read role/title/value of a match               |
| `click_menu_item`    | `path` (`"File>Save"`), `app?`             | Navigate the menu bar deterministically        |
| `get_selected_text`  | —                                          | AX selected text (clipboard fallback)          |

### Window & app management (needs `dist/ax-helper` for window tools)

| Tool              | Arguments                                  | Notes                                |
| ----------------- | ------------------------------------------ | ------------------------------------ |
| `list_windows`    | `app?`                                     | Titles, minimized state, frames      |
| `focus_window`    | `app?`, `title?`, `index?`                 | Raise + activate a window            |
| `move_window`     | `…target`, `x`, `y`                        | Move top-left to (x,y)               |
| `resize_window`   | `…target`, `width`, `height`               |                                      |
| `minimize_window` | `…target`, `unminimize?`                   | Minimize to Dock / restore           |
| `quit_app`        | `name`                                     | Graceful Quit                        |
| `hide_app`        | `name`                                     | Like Cmd+H                           |
| `open_url`        | `url`                                      | Default browser / handler            |
| `reveal_in_finder`| `path`                                     | Select a file/folder in Finder       |

### Perception extras (needs `dist/vision-ocr`)

| Tool                   | Arguments                                  | Notes                                          |
| ---------------------- | ------------------------------------------ | ---------------------------------------------- |
| `screenshot_annotated` | `region?`, `display_index?`, `fast?`, `lang?`, `max_width?` | Set-of-Marks: numbered boxes over each OCR line + index→text→x,y legend |
| `get_pixel_color`      | `x`, `y`                                   | RGB + hex of one screen pixel (state detection)|

### Deterministic input

| Tool             | Arguments                                  | Notes                                          |
| ---------------- | ------------------------------------------ | ---------------------------------------------- |
| `click_modified` | `modifiers[]`, `button?`, `x?`, `y?`       | cmd/shift/ctrl/alt/fn + click; button incl. `triple` |
| `triple_click`   | `x?`, `y?`                                 | Select a whole line/paragraph                  |
| `hover`          | `x`, `y`, `dwell_ms?`                       | Trigger tooltips / hover menus                 |
| `key_down`       | `key?`, `modifiers?`                        | Hold ANY key with CGEvent (e.g. 'w', 'space'); modifier-only fallback |
| `key_up`         | `key?`, `modifiers?`                        | Release a held key/modifier                    |
| `key_tap`        | `key`, `modifiers?`, `repeat?`, `delay_ms?` | CGEvent tap; works where AppleScript keystroke is ignored (games) — needs `dist/cgevent` |
| `paste`          | `text?`                                     | Cmd+V (optionally set clipboard first)         |

### Robust agent loops

| Tool                    | Arguments                                  | Notes                                          |
| ----------------------- | ------------------------------------------ | ---------------------------------------------- |
| `wait_for_text`         | `query`, `timeout_ms?`, `interval_ms?`, `region?`, `regex?`, `case_sensitive?`, `lang?` | Poll OCR until text appears; returns clickable coord |
| `wait_for_element`      | matchers, `timeout_ms?`, `interval_ms?`    | Poll the AX tree until an element appears      |
| `wait_for_screen_change`| `region?`, `timeout_ms?`, `interval_ms?`   | Confirm an action had a visible effect         |

### OCR tools in practice

`find_text` / `click_text` are the closest equivalent to the old Computer Use
"click the button labeled X" behavior. Coordinates are normalized by Vision and
mapped onto screen **points** (top-left origin), so the returned `x,y` can be fed
straight into `left_click`. Default OCR languages are German + English; override
with `lang: ["en-US"]` etc. `fast: true` trades a little accuracy for speed.

Example agent flow: `find_text {query:"Senden"}` → `left_click {x,y}` of the best
match, or just `click_text {query:"Senden"}` to do both at once.

### Recommended workflow (most reliable first)

1. **Accessibility first.** For native macOS apps, prefer `get_ui_elements` /
   `find_element` → `click_element`, `set_element_value`, and `click_menu_item`.
   These act on real UI elements and don't depend on pixels, fonts or theming.
2. **Set-of-Marks / OCR for the rest.** When AX is unavailable (web content,
   custom canvases, games), use `screenshot_annotated` to get numbered targets,
   or `find_text` / `click_text`.
3. **Wait, don't guess.** Use `wait_for_element` / `wait_for_text` /
   `wait_for_screen_change` to synchronize with the UI instead of fixed `wait`.
4. **Verify.** `get_pixel_color`, `get_element_value` or a follow-up screenshot to
   confirm the result before the next step.

## Verifying it's wired up

Fully quit and relaunch Codex Desktop, then in a fresh chat say:

> Take a screenshot and describe what you see.

If Codex reports the tool is unavailable, check:

```bash
# Does the config parse?
python3.12 -c "import tomllib, pathlib; print(tomllib.loads(pathlib.Path('~/.codex/config.toml').expanduser().read_text())['mcp_servers']['computer-use-intel'])"

# Does the server start under Codex's env?
env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" \
  "$(command -v node)" "$PWD/dist/server.js" < /dev/null
# (should print: "[computer-use-intel] ... ready over stdio" and then exit on EOF)
```

## Caveats

- **Codex ≥ 26.527 removed the bundled `computer-use` plugin entirely.** The
  bundled marketplace now ships `browser`, `chrome` and `latex` instead, and the
  "Computernutzung" settings page no longer lists a Computer Use plugin. This is
  not a bug or a VPN/region issue — desktop control on Intel now lives in this
  project. With Option A (local plugin) it is `@computer-use-intel` in the
  composer again; otherwise just ask Codex in a normal chat ("take a screenshot
  and click …") and it calls these tools directly. The stale
  `[plugins."computer-use@openai-bundled"] enabled = false` entry is harmless.
- **After a Codex app update/rebuild, re-grant macOS permissions.** TCC keys on
  the app's code signature; a new build can invalidate prior grants (Screen
  Recording errors like `could not create image from display`). Clear the stale
  entries and re-approve:
  ```bash
  tccutil reset ScreenCapture com.openai.codex
  tccutil reset Accessibility com.openai.codex
  ```
  Then relaunch Codex and approve the prompts (or add `/Applications/Codex.app`
  manually in System Settings).
- Scroll posts real CGEvent scroll-wheel events (pixel/line units, both axes,
  optional smooth stepping) when `dist/cgevent` is present, and falls back to
  AppleScript `System Events … scroll` / arrow keys otherwise.
- **Settings → "Computer Use" / "Computernutzung" is a different feature.** That
  page (incl. the "Locked Usage" / "Gesperrte Nutzung" — "let Codex use your Mac
  when it's locked" toggle) belongs to Codex **Remote Control** (driving this Mac
  from elsewhere), an OpenAI-managed capability backed by remote-control
  enrollment (`electron-local-remote-control-*` state keys). It is unrelated to
  this MCP/plugin. On Intel the toggle may fail with "could not be updated", and
  "while locked" would not work with a `screencapture`/`cliclick` approach anyway
  (the macOS lock screen blocks screen capture and event injection). Leave it
  off; this project provides only local control of the unlocked Mac.
- No auto-update. When you re-run the DMG-Intel converter, nothing here
  needs to change unless the Codex MCP protocol version itself bumps.

## License

MIT
