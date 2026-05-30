---
name: computer-use-intel
description: "Control this Intel (x86_64) Mac with Codex: look at the screen, click, type, scroll, read on-screen text (OCR), inspect and drive native UI via the Accessibility tree, navigate menus, manage windows, and use the clipboard. Use whenever the user asks to use, control, or look at their Mac, or asks for 'computer use' / 'Computernutzung'."
---

# Computer Use (Intel)

This plugin exposes the `computer-use-intel` MCP server, an x86_64 drop-in for the
arm64-only bundled Computer Use plugin. Use it to control THIS Mac: perceive the
screen and drive mouse, keyboard, windows and the clipboard.

All coordinates are screen points (origin = top-left of the main display). The
tools map OCR/Accessibility results straight onto these points, so a returned
`x,y` can be passed directly to a click tool.

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
- `wait_for_screen_change` (confirm an action had a visible effect).

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
  allowed" or "could not create image from display", re-grant those in System
  Settings → Privacy & Security.
- This is local control of the Mac in front of you. It does NOT work while the
  screen is locked, and it is unrelated to the Settings → Computer Use page
  (that is Codex Remote Control, an OpenAI-managed feature).
- When you show the user a screenshot, embed it inline in your final Markdown
  response.
