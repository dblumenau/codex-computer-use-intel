---
name: computer-use-intel
description: "Control this Intel (x86_64) Mac with Codex: look at the screen, click, type, scroll, read on-screen text (OCR), inspect and drive native UI via the Accessibility tree, navigate menus, manage windows, and use the clipboard. Use whenever the user asks to use, control, or look at their Mac, or asks for 'computer use' / 'Computernutzung'."
---

# Computer Use (Intel)

This plugin exposes a model-independent `computer-use-intel` MCP server for
native desktop control. Use it to control THIS Mac: perceive the
screen and drive mouse, keyboard, windows and the clipboard.

All coordinates are screen points (origin = top-left of the main display). The
tools map OCR/Accessibility results straight onto these points, so a returned
`x,y` can be passed directly to a click tool.

## Preferred visual workflow (v1.3)

1. Use `get_desktop_state` to receive a current screenshot, exact geometry,
   frontmost app identity and compact visible Accessibility elements. Use
   `region` for small text or controls; request full resolution when useful.
2. Prefer `act_and_observe` for a single click, text entry, key or scroll. Supply
   the expected frontmost app's bundle ID. If necessary, call `focus_app` first.
   For a point identified visually, use the returned `screenshot_id` and x/y in
   the returned image's pixels. For AX/OCR positions, omit `screenshot_id`:
   these x/y values already represent screen points.
3. When a specific result is known, add `expect` with an element matcher and
   optionally `exact_value`. `matched` confirms this postcondition; `observed`
   only means fresh state was returned. `already_satisfied` skips the input.
4. Inspect the new screenshot/UI state. A completed input command or a timed-out
   expectation does not prove the user's task succeeded. An uncertain action
   must not be blindly repeated. If AXPress has no effect, inspect again and
   explicitly choose `method: "coordinate"` for an appropriate element.

Screenshot references are limited to this MCP process, expire after 120 seconds
and are invalidated by input through this server. The app and display layout are
checked before image clicks. External user input and same-app navigation can
still invalidate a visual target: take a fresh screenshot after either occurs.
No automatic fallback click is attempted after a successfully dispatched AXPress.

In Codex, use its existing code-execution tool to inspect/filter tool results and
orchestrate this workflow. Return image content blocks at their original supplied
resolution. Keep dependent GUI actions sequential; do not launch parallel desktop
mutations. A separate REPL or a model/API-key configuration inside this plugin is
not needed for Astra.

## Choose the most reliable tool first

1. Accessibility (structured, deterministic) — PREFER for native macOS apps.
   - `get_ui_elements` (dump the UI tree: role/title/value + clickable center),
     `find_element` (search by role/title/value),
     `click_element` (real AXPress, with coordinate-click fallback),
     `set_element_value` (fill a field directly), `get_element_value`.
   - `click_menu_item` with a path like `"File>Save"` for menu bar actions.
   - `list_windows`, `focus_window`, `move_window`, `resize_window`,
     `minimize_window` for window management.
   - `get_selected_text` for the current selection.
2. Vision / Set-of-Marks — when Accessibility is unavailable (web content,
   custom canvases, games):
   - `find_text` / `click_text` (OCR a label and click it),
     `ocr_screen` (read all on-screen text),
     `screenshot_annotated` (numbered boxes + index→text→x,y legend),
     `get_pixel_color` (state/colour detection).
3. Raw input when you already know the coordinates:
   - `screenshot` (supports `max_width` to save tokens), `mouse_move`,
     `left_click` / `right_click` / `middle_click` / `double_click`,
     `triple_click`, `click_modified` (cmd/shift/ctrl/alt/fn + click),
     `left_click_drag`, `hover`, `scroll` (real CGEvent wheel; `pixels`/`smooth`),
     `type`, `key`, `key_down` / `key_up` (hold any key via CGEvent),
     `key_tap` (works where AppleScript keystroke is ignored), `paste`.
4. App & system:
   - `open_app`, `focus_app`, `list_apps`, `frontmost_app`, `quit_app`,
     `hide_app`, `open_url`, `reveal_in_finder`,
     `get_clipboard` / `set_clipboard`.
5. Escape hatches: `run_applescript`, `cliclick_raw`.

## Robust loops (do not guess)

Synchronize with the UI instead of fixed sleeps:
- `wait_for_element` (poll the Accessibility tree),
- `wait_for_text` (poll OCR; returns a clickable coordinate),
- `wait_for_screen_change` (watch changes after the call starts; its baseline
  cannot confirm an earlier action).

## Working pattern

1. Perceive: `frontmost_app` + `get_ui_elements` (or `screenshot` /
   `ocr_screen`) to understand the current state.
2. Act: prefer `click_element` / `click_menu_item` / `set_element_value`; fall
   back to `click_text` or coordinate clicks.
3. Wait: use a `wait_for_*` tool for the expected change.
4. Verify: re-check with `get_element_value`, `get_pixel_color`, or a fresh
   screenshot before the next step.

## Notes and limits

- Requires macOS permissions for the Codex host process: Accessibility (mouse,
  keyboard, scroll, and all `get_ui_elements`/`click_*`/window tools) and Screen
  Recording (screenshots + OCR). If a tool reports "assistive access is not
  allowed", check System Settings → Privacy & Security. If screen capture fails,
  first check whether the screen is awake and unlocked; the error alone does not
  establish a missing permission.
- This is local control of the Mac in front of you. It does NOT work while the
  screen is locked. It is managed in Settings → Plugins; the app's own Computer
  Use settings manage the official integrations separately.
- When you show the user a screenshot, embed it inline in your final Markdown
  response.
