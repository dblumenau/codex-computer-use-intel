# Computer Use (Intel) — Codex plugin

A drop-in **Computer Use** capability for **OpenAI Codex Desktop on Intel
(x86_64) Macs**, packaged as a local Codex plugin.

This project provides local desktop control through a self-contained MCP server
built on native macOS tooling. It is available as `@computer-use-intel` in Codex.
It was created when the bundled native helpers did not run on Intel. Official
availability varies by app build; this plugin does not depend on OpenAI's native
Computer Use service or replace the official browser integration.

## Version 1.3: see, act, verify

- Screenshots return their actual pixel size, captured rectangle in screen
  points, conversion factors and a short-lived `screenshot_id`. Retina scaling,
  downscaling and crops use the same explicit mapping.
- `get_desktop_state` combines an image, frontmost app identity and a compact
  visible Accessibility tree. The image preserves its supplied resolution;
  request a small region to inspect fine text without sending the whole screen.
- `act_and_observe` sends one input, optionally checks an expected element or
  exact field value, then returns a fresh image and UI state. It distinguishes
  matched, already satisfied, observed, timed out and failed checks. It never
  replays input automatically.
- Image clicks require the captured app and display layout to remain current.
  References expire after 120 seconds or an input through this server. Requests
  are serialized. External user input can still change a page; observe again
  whenever the interface changes.
- `focus_app` resolves bundle IDs and confirms that the app became frontmost.
- Ordinary clicks and Unicode typing use the native HID event helper. Text
  input preserves the clipboard, and postconditions verify actual delivery.

This helps GPT-6 Astra use visual reasoning with less coordinate ambiguity and
fewer tool round trips. The server remains model-independent. OpenAI recommends
code execution for Astra and allows existing MCP UI tools to be retained;
Codex can orchestrate these tools without an additional model API integration.
See [OpenAI's Computer Use guide](https://developers.openai.com/api/docs/guides/tools-computer-use).

## What you get

- Tools to perceive and control the local Mac: screenshots (incl.
  Set-of-Marks annotated), mouse/keyboard (with modifier holds and real CGEvent
  scrolling), on-device **Vision OCR** ("find text on screen"), the macOS
  **Accessibility** UI tree (read elements, click buttons/menu items, set field
  values), window management, clipboard, and pixel sampling.
- A Codex **plugin** (local marketplace) so it shows up in `Settings → Plugins`
  and as `@computer-use-intel`.
- Native **x86_64** Swift helpers for OCR, Accessibility, and CGEvent input,
  with prebuilt binaries included so a target machine does **not** need Xcode.

See [`computer-use-intel/README.md`](computer-use-intel/README.md) for the full
tool reference and internals.

## Requirements

- macOS 12+ on an **Intel (x86_64)** Mac.
- [Node.js](https://nodejs.org/) (x86_64) on `PATH` — `brew install node`.
- [`cliclick`](https://github.com/BlueM/cliclick) — `brew install cliclick`
  (required for mouse/keyboard injection).
- Optional: **Xcode** (full, not just Command Line Tools) to rebuild the native
  Swift helpers from source. If Xcode is absent, the installer uses the bundled
  prebuilt x86_64 binaries instead.
- Codex Desktop with `[features] apps = true` and `plugins = true`.

## Install

```bash
unzip codex-computer-use-intel.zip
cd codex-computer-use-intel
./install.sh                 # build + generate .mcp.json + print config snippet
# or, to also wire up ~/.codex/config.toml automatically:
./install.sh --write-config
```

The installer:

1. installs npm dependencies and builds `computer-use-intel/dist/server.js`;
2. builds the native Swift helpers, or falls back to the included prebuilt
   x86_64 binaries (and clears their quarantine flag);
3. writes `marketplace/plugins/computer-use-intel/.mcp.json` with absolute paths
   for this machine;
4. prints (or appends) the `~/.codex/config.toml` entries below.

If you did not use `--write-config`, add this to `~/.codex/config.toml`
(the installer prints it with the correct absolute path for your machine):

```toml
[features]
apps = true
plugins = true

[plugins."computer-use@openai-bundled"]
enabled = false

[marketplaces.codexintel-local]
last_updated = "1970-01-01T00:00:00Z"
source_type = "local"
source = "/ABSOLUTE/PATH/TO/codex-computer-use-intel/marketplace"

[plugins."computer-use-intel@codexintel-local"]
enabled = true
```

Then grant permissions and restart Codex (see below).

## macOS permissions

Grant these to the **Codex** app (the process that launches the MCP server):

- **Accessibility** — `System Settings → Privacy & Security → Accessibility`.
  Needed for mouse/keyboard/scroll injection and all Accessibility tools.
- **Screen Recording** — `System Settings → Privacy & Security → Screen Recording`.
  Needed for screenshots and OCR.

After granting, fully quit Codex with **Cmd+Q** (not just closing the window)
and relaunch.

## Verify

- `Settings → Plugins` lists **Computer Use (Intel)** (enable it if needed).
- The composer accepts **`@computer-use-intel`**.
- Ask Codex: "Take a screenshot and tell me which app is in front."

This plugin is managed under `Settings → Plugins`. The app's own Computer Use
settings manage its official integrations separately.

## Update

Update the checkout at the path used by your existing marketplace, then run
`./install.sh` again. A second checkout does not update a separately installed
copy. Start a new Codex task after the plugin is refreshed; existing MCP
processes may keep the previous code until they reconnect. If needed, restart
Codex when no other tasks are running.

Regression tests: `cd computer-use-intel && npm ci && npm test`.
The tests cover coordinate transforms, expired references, serialized requests
and verification failures without interacting with the desktop. Native builds
and the interactive test fixture require macOS. See [CHANGELOG.md](CHANGELOG.md).

To run the opt-in desktop smoke after building, use
`node scripts/live-smoke.mjs --run` from `computer-use-intel/`. It opens a
temporary fixture, clicks a target from a downscaled crop, enters a Unicode
test string, checks expected/absent states, and closes only that fixture.
Keep the Mac unlocked and avoid other desktop input during the smoke. Optional
`--report /path/result.json` saves the check results and a PNG of the fixture.

## Uninstall

```bash
./uninstall.sh                # remove the appended config block + generated .mcp.json
./uninstall.sh --print-only   # just show what to remove
```

## How it works

```
codex-computer-use-intel/
  install.sh / uninstall.sh
  computer-use-intel/                 # the MCP server (TypeScript + Swift helpers)
    src/                              # server.ts, macos.ts, *.swift, ocr.py
    prebuilt/                         # x86_64 vision-ocr, ax-helper, cgevent (no-Xcode fallback)
    package.json, tsconfig.json
  marketplace/                        # the local Codex marketplace
    .agents/plugins/marketplace.json  # marketplace manifest (lists the plugin)
    plugins/computer-use-intel/
      .codex-plugin/plugin.json       # plugin manifest (the @computer-use-intel alias)
      .mcp.json(.example)             # bundles the MCP server (generated by install.sh)
      skills/computer-use-intel/SKILL.md
```

Codex discovers the marketplace via `[marketplaces.*]` in `config.toml`, reads
`.agents/plugins/marketplace.json`, loads the plugin, and auto-discovers the
plugin's `.mcp.json` to launch the MCP server. The server resolves its native
helpers relative to its own `dist/` directory, so it is location-independent
once `.mcp.json` points at it.

## Limitations

- Local control of the **unlocked** Mac only. It does not work at the lock
  screen (macOS blocks screen capture and event injection there), and it is
  unrelated to Codex Remote Control.
- Built and tested for Intel/x86_64. On Apple Silicon, use the official Computer
  Use plugin instead.
- After a Codex app update, you may need to re-grant Accessibility / Screen
  Recording (TCC keys on the app's code signature).

## License

MIT — see [LICENSE](LICENSE).
