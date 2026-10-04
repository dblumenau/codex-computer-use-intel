# Changelog

## 1.3.1 — 2026-10-04

- Fill the activity rim out to the screen corners: its outer edge is square to
  the display while the inner edge keeps its rounded curve and glow.
- Draw the mouse cursor in `screenshot`, `get_desktop_state` and
  `act_and_observe` captures by default; pass `show_cursor: false` to omit it.
- Move the on-screen pointer with every click, move, long press, drag and
  positioned scroll. The helper warps the cursor before posting input, since a
  posted mouse-moved event alone leaves the drawn pointer in place.
- Glide the pointer to its target in eased steps (80–300 ms by distance)
  instead of teleporting, and shed a fading trail of rainbow sparkles along
  its path while the activity overlay is showing.

## 1.3.0 — 2026-09-05

- Add exact screenshot geometry derived from CoreGraphics display bounds and the
  returned PNG dimensions, including Retina/downscale and cropped captures.
- Add `get_desktop_state` for a screenshot with compact Accessibility state and
  frontmost app identity. Image outputs request original supplied detail.
- Add `act_and_observe` for one action, optional Accessibility postcondition and
  fresh state. Report observed, matched, already satisfied, timeout and error
  separately; never replay input after a failed observation.
- Add bounded screenshot references; reject expired/invalidated references and
  changed app/display identities. Serialize this server's desktop calls.
- Fix focus by bundle ID, confirm foreground activation, and honor element
  indices in Accessibility searches.
- Send ordinary clicks and literal Unicode text through the native HID event
  helper. Text input does not modify the clipboard. Verify delivery through
  postconditions; event submission alone is not a success guarantee.
- Use the actual capture bounds for OCR coordinates and annotated geometry.
- Reject clipped regions and ambiguous region/display combinations. Clean up
  failed captures. Keep existing raw tool names and screen-point semantics.
- Correct the screen-change wait description: it captures its baseline when
  invoked and cannot verify an earlier action.
- Add coordinate and workflow regression tests plus a native AppKit fixture for
  live screenshot, click and Unicode-input checks.
- Build bundled Intel helpers with a macOS 12 deployment target. The installer
  rejects TypeScript build failures and replaces stale native helpers with the
  current release's builds or prebuilts.

The server is model-independent. This release does not change Codex model or
reasoning settings and does not integrate OpenAI's separate native service.
