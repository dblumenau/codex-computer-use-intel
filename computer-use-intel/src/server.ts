#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { withActivity } from "./activity.js";
import { DesktopQueue } from "./workflow.js";
import { captureObservation, observationResult, registerPerceptionTools, screenshots } from "./perception-tools.js";

import {
  annotateScreen,
  axClick,
  axDump,
  axFind,
  axGetValue,
  axMenu,
  axSetValue,
  axWindowAction,
  axWindows,
  click,
  clickWithModifiers,
  cliclick,
  clipboardGet,
  clipboardSet,
  drag,
  findText,
  focusApp,
  frontmostApp,
  getCursorPosition,
  getPixelColor,
  getScreenSize,
  getSelectedText,
  hasAx,
  hasCgEvent,
  hasOcr,
  hideApp,
  hover,
  keyDown,
  keyTap,
  keyUp,
  ocrBackend,
  listRunningApps,
  longPress,
  moveCursor,
  ocrScreen,
  open as openApp,
  openUrl,
  paste,
  pressKey,
  quitApp,
  revealInFinder,
  runApplescript,
  scroll,
  sleep,
  takeScreenshot,
  typeText,
  waitForElement,
  waitForScreenChange,
  waitForText,
  which,
} from "./macos.js";

const SERVER_NAME = "computer-use-intel";
const SERVER_VERSION = "1.3.1";

async function main(): Promise<void> {
  // Hard-fail early if cliclick is missing so the failure is visible in Codex's
  // MCP startup diagnostics rather than as per-tool errors.
  if (!which("cliclick")) {
    process.stderr.write(
      "[computer-use-intel] cliclick not found on PATH. Install with: brew install cliclick\n",
    );
    process.exit(2);
  }
  if (!hasAx() || !hasCgEvent()) {
    process.stderr.write("[computer-use-intel] v1.3 requires updated ax-helper and cgevent for app identity and measured screenshot geometry. Run ./install.sh (includes prebuilt Intel helpers).\n");
    process.exit(2);
  }

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Drop-in macOS 'Computer Use' MCP server for Intel (x86_64) Macs. " +
        "Uses cliclick, osascript, and screencapture under the hood. " +
        "Coordinates are screen-space in points (origin = top-left of main display). " +
        "Prefer get_desktop_state then act_and_observe for visual workflows. " +
        "Image clicks use screenshot_id and image pixels; AX/OCR coordinates are already screen points. " +
        "Verify the resulting state: dispatched input is not proof of success. " +
        "Never run dependent desktop actions in parallel or automatically replay uncertain input.",
    },
  );

  const queue = new DesktopQueue();
  const readOnly = new Set(["screenshot", "screenshot_annotated", "screen_size", "cursor_position",
    "get_desktop_state", "get_ui_elements", "find_element", "get_element_value", "list_windows",
    "list_apps", "frontmost_app", "get_clipboard", "find_text", "ocr_screen", "get_pixel_color",
    "wait_for_text", "wait_for_element", "wait_for_screen_change", "wait"]);
  // Serialize every request against this shared desktop. Legacy input invalidates old image references.
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: any, callback: any) => register(name, config,
    (...args: any[]) => queue.run(() => withActivity(async () => {
      if (!readOnly.has(name) && name !== "act_and_observe") screenshots.invalidate();
      return callback(...args);
    })))) as typeof server.registerTool;
  registerPerceptionTools(server);

  server.registerTool(
    "screenshot",
    {
      title: "Take screenshot",
      description:
        "Capture a PNG of the main display (default), a specific display, or a rectangular region. " +
        "Returns inline PNG, exact image-to-screen geometry and a screenshot_id for act_and_observe image clicks. " +
        "AX/OCR coordinates need no scaling. Take a fresh capture after UI changes.",
      inputSchema: {
        region: z
          .object({
            x: z.number().int(),
            y: z.number().int(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .optional()
          .describe("Optional rectangle in screen points."),
        display_index: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("0-based display index; omit for main display."),
        show_cursor: z.boolean().optional().describe("Render the mouse cursor in the capture (default true)."),
        max_width: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Downscale to at most this pixel width (token-efficient; e.g. 1280). Skips upscaling."),
      },
    },
    async ({ region, display_index, show_cursor, max_width }) => {
      return observationResult(await captureObservation({
        region,
        displayIndex: display_index,
        showCursor: show_cursor,
        maxWidth: max_width,
      }));
    },
  );

  server.registerTool(
    "screen_size",
    {
      title: "Get main display size",
      description: "Returns the logical width/height of the main display in points.",
      inputSchema: {},
    },
    async () => {
      const size = await getScreenSize();
      return {
        content: [{ type: "text", text: JSON.stringify(size) }],
      };
    },
  );

  server.registerTool(
    "cursor_position",
    {
      title: "Get cursor position",
      description: "Returns the current mouse cursor position in screen points.",
      inputSchema: {},
    },
    async () => {
      const pos = await getCursorPosition();
      return { content: [{ type: "text", text: JSON.stringify(pos) }] };
    },
  );

  server.registerTool(
    "mouse_move",
    {
      title: "Move mouse",
      description: "Move the mouse cursor to absolute screen coordinates.",
      inputSchema: {
        x: z.number().int(),
        y: z.number().int(),
      },
    },
    async ({ x, y }) => {
      await moveCursor(x, y);
      return { content: [{ type: "text", text: `moved to ${x},${y}` }] };
    },
  );

  const clickInput = {
    x: z.number().int().optional(),
    y: z.number().int().optional(),
  };

  server.registerTool(
    "left_click",
    {
      title: "Left click",
      description: "Left-click at the given point, or at the current cursor position if omitted.",
      inputSchema: clickInput,
    },
    async ({ x, y }) => {
      await click("left", x, y);
      return { content: [{ type: "text", text: "left_click ok" }] };
    },
  );

  server.registerTool(
    "long_press",
    {
      title: "Long press",
      description:
        "Press and hold the left mouse button at a point, then release it. " +
        "duration_ms defaults to 1000 and is capped at 60000.",
      inputSchema: {
        x: z.number().int(),
        y: z.number().int(),
        duration_ms: z.number().int().min(1).max(60_000).default(1_000),
      },
    },
    async ({ x, y, duration_ms }) => {
      await longPress(x, y, duration_ms);
      return {
        content: [{ type: "text", text: `long_press ${x},${y} for ${duration_ms}ms ok` }],
      };
    },
  );

  server.registerTool(
    "right_click",
    {
      title: "Right click",
      description: "Right-click at the given point, or at the current cursor position if omitted.",
      inputSchema: clickInput,
    },
    async ({ x, y }) => {
      await click("right", x, y);
      return { content: [{ type: "text", text: "right_click ok" }] };
    },
  );

  server.registerTool(
    "middle_click",
    {
      title: "Middle click",
      description: "Middle-click at the given point, or at the current cursor position if omitted.",
      inputSchema: clickInput,
    },
    async ({ x, y }) => {
      await click("middle", x, y);
      return { content: [{ type: "text", text: "middle_click ok" }] };
    },
  );

  server.registerTool(
    "double_click",
    {
      title: "Double click",
      description: "Double-click at the given point, or at the current cursor position if omitted.",
      inputSchema: clickInput,
    },
    async ({ x, y }) => {
      await click("double", x, y);
      return { content: [{ type: "text", text: "double_click ok" }] };
    },
  );

  server.registerTool(
    "left_click_drag",
    {
      title: "Left-click drag",
      description: "Press left button at 'from', drag to 'to', release.",
      inputSchema: {
        from: z.object({ x: z.number().int(), y: z.number().int() }),
        to: z.object({ x: z.number().int(), y: z.number().int() }),
      },
    },
    async ({ from, to }) => {
      await drag(from, to);
      return {
        content: [{ type: "text", text: `dragged ${from.x},${from.y} -> ${to.x},${to.y}` }],
      };
    },
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll",
      description:
        "Scroll the view under (x,y) — or the current pointer. 'amount' = number of wheel ticks. Uses real " +
        "CGEvent scroll-wheel events when available (smooth, both axes). Set pixels=true for pixel-unit scrolling " +
        "(amount*40 px) and smooth=true to split into many small steps for a natural glide.",
      inputSchema: {
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().positive().default(3),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        pixels: z.boolean().optional().describe("Use pixel units instead of lines (finer, larger travel)."),
        smooth: z.boolean().optional().describe("Split into many small steps for smooth scrolling."),
      },
    },
    async ({ direction, amount, x, y, pixels, smooth }) => {
      const at = x !== undefined && y !== undefined ? { x, y } : undefined;
      await scroll(direction, amount, at, { pixels, smooth });
      return { content: [{ type: "text", text: `scrolled ${direction} x${amount}${pixels ? " (px)" : ""}` }] };
    },
  );

  server.registerTool(
    "type",
    {
      title: "Type text",
      description:
        "Type literal Unicode text through native HID events without changing the clipboard. Use 'key' for combos. " +
        "Text/spacing that exceeds a 45-second input budget is rejected before input; split long text into verified calls.",
      inputSchema: {
        text: z.string(),
        delay_ms: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Per-character delay. 0 = as fast as the OS allows."),
      },
    },
    async ({ text, delay_ms }) => {
      await typeText(text, delay_ms ?? 0);
      return { content: [{ type: "text", text: `typed ${text.length} chars` }] };
    },
  );

  server.registerTool(
    "key",
    {
      title: "Press a key or combo",
      description:
        "Accepts single keys (Return, Escape, Tab, Space, arrow-up, arrow-left, f1..f12, delete, home, end, page-up, page-down) and combos like 'cmd+c', 'cmd+shift+4', 'ctrl+alt+delete'.",
      inputSchema: {
        keys: z.string().min(1),
      },
    },
    async ({ keys }) => {
      await pressKey(keys);
      return { content: [{ type: "text", text: `pressed ${keys}` }] };
    },
  );

  server.registerTool(
    "wait",
    {
      title: "Wait",
      description: "Sleep for the given number of milliseconds (capped at 60s).",
      inputSchema: { ms: z.number().int().positive().max(60_000) },
    },
    async ({ ms }) => {
      await sleep(ms);
      return { content: [{ type: "text", text: `waited ${ms}ms` }] };
    },
  );

  server.registerTool(
    "open_app",
    {
      title: "Open / launch app",
      description:
        "Launch (or bring forward) a macOS app by name, bundle id, or path. Examples: 'Safari', 'com.apple.Terminal', '/Applications/Xcode.app'.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => {
      await openApp(name);
      return { content: [{ type: "text", text: `opened ${name}` }] };
    },
  );

  server.registerTool(
    "focus_app",
    {
      title: "Focus / activate app",
      description: "Bring an already-running app to the foreground without re-launching.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => {
      await focusApp(name);
      return { content: [{ type: "text", text: `focused ${name}` }] };
    },
  );

  server.registerTool(
    "list_apps",
    {
      title: "List user-visible running apps",
      description:
        "Return the names of currently running non-background apps (as reported by System Events).",
      inputSchema: {},
    },
    async () => {
      const apps = await listRunningApps();
      return { content: [{ type: "text", text: JSON.stringify(apps) }] };
    },
  );

  server.registerTool(
    "frontmost_app",
    {
      title: "Get frontmost app",
      description: "Return the name of the process that currently owns keyboard focus.",
      inputSchema: {},
    },
    async () => {
      const name = await frontmostApp();
      return { content: [{ type: "text", text: name }] };
    },
  );

  server.registerTool(
    "run_applescript",
    {
      title: "Run AppleScript",
      description:
        "Escape hatch: evaluate an arbitrary AppleScript snippet via osascript and return its stdout. " +
        "Use sparingly; prefer dedicated tools above when possible.",
      inputSchema: {
        script: z.string().min(1),
      },
    },
    async ({ script }) => {
      const out = await runApplescript(script);
      return { content: [{ type: "text", text: out || "(no output)" }] };
    },
  );

  server.registerTool(
    "cliclick_raw",
    {
      title: "Raw cliclick passthrough",
      description:
        "Advanced escape hatch. Passes arguments directly to cliclick (see `man cliclick`). " +
        "Example args: ['c:500,400','w:200','kp:return']",
      inputSchema: {
        args: z.array(z.string()).min(1),
      },
    },
    async ({ args }) => {
      const out = await cliclick(...args);
      return { content: [{ type: "text", text: out || "ok" }] };
    },
  );

  const regionSchema = z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional()
    .describe("Optional rectangle in screen points to limit OCR to. Omit for the full main display.");

  const ocrAvailable = hasOcr();

  server.registerTool(
    "find_text",
    {
      title: "Find text on screen (OCR)",
      description:
        "Screenshot the screen (or a region), run on-device OCR (Apple Vision), and return every line " +
        "matching the query together with the clickable screen-point center of its bounding box. " +
        "This is the key tool for 'click the button labeled X' style automation: call find_text, then " +
        "left_click the returned x,y. Matching is case-insensitive substring by default.",
      inputSchema: {
        query: z.string().min(1).describe("Text to look for."),
        region: regionSchema,
        display_index: z.number().int().nonnegative().optional(),
        regex: z.boolean().optional().describe("Treat query as a JavaScript regular expression."),
        case_sensitive: z.boolean().optional(),
        fast: z.boolean().optional().describe("Use the faster, slightly less accurate OCR level."),
        lang: z
          .array(z.string())
          .optional()
          .describe('OCR languages, e.g. ["de-DE","en-US"]. Defaults to German + English.'),
      },
    },
    async ({ query, region, display_index, regex, case_sensitive, fast, lang }) => {
      if (!ocrAvailable) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "OCR helper (vision-ocr) is not built. Run `npm run build` in computer-use-intel (needs swiftc).",
            },
          ],
        };
      }
      const { matches, lineCount } = await findText(query, {
        region,
        displayIndex: display_index,
        regex,
        caseSensitive: case_sensitive,
        fast,
        langs: lang,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { query, matchCount: matches.length, scannedLines: lineCount, matches },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "click_text",
    {
      title: "Find text and click it",
      description:
        "Convenience tool: OCR the screen, find the text, and click the center of the chosen match in one step. " +
        "By default clicks the first match. Returns the coordinate that was clicked. If multiple matches exist " +
        "and 'match_index' is out of range, nothing is clicked and the matches are returned instead.",
      inputSchema: {
        query: z.string().min(1),
        match_index: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Which match to click when several are found (0-based, default 0)."),
        button: z.enum(["left", "right", "middle", "double"]).optional().describe("Default: left."),
        region: regionSchema,
        display_index: z.number().int().nonnegative().optional(),
        regex: z.boolean().optional(),
        case_sensitive: z.boolean().optional(),
        fast: z.boolean().optional(),
        lang: z.array(z.string()).optional(),
      },
    },
    async ({ query, match_index, button, region, display_index, regex, case_sensitive, fast, lang }) => {
      if (!ocrAvailable) {
        return {
          isError: true,
          content: [
            { type: "text", text: "OCR helper (vision-ocr) is not built. Run `npm run build`." },
          ],
        };
      }
      const { matches } = await findText(query, {
        region,
        displayIndex: display_index,
        regex,
        caseSensitive: case_sensitive,
        fast,
        langs: lang,
      });
      const idx = match_index ?? 0;
      if (matches.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `No on-screen text matched "${query}".` }],
        };
      }
      if (idx >= matches.length) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `match_index ${idx} out of range (${matches.length} matches). Matches:\n${JSON.stringify(matches, null, 2)}`,
            },
          ],
        };
      }
      const target = matches[idx];
      await click(button ?? "left", target.x, target.y);
      return {
        content: [
          {
            type: "text",
            text: `${button ?? "left"}-clicked "${target.text}" at ${target.x},${target.y} (${matches.length} match(es) total).`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "ocr_screen",
    {
      title: "Read all text on screen (OCR)",
      description:
        "Screenshot the screen (or a region) and return all recognized text as plain text, plus per-line " +
        "screen coordinates. Use this to read the screen without sending an image, or to locate UI text.",
      inputSchema: {
        region: regionSchema,
        display_index: z.number().int().nonnegative().optional(),
        fast: z.boolean().optional(),
        lang: z.array(z.string()).optional(),
        include_coordinates: z
          .boolean()
          .optional()
          .describe("Also return per-line x,y centers (default false: text only)."),
      },
    },
    async ({ region, display_index, fast, lang, include_coordinates }) => {
      if (!ocrAvailable) {
        return {
          isError: true,
          content: [
            { type: "text", text: "OCR helper (vision-ocr) is not built. Run `npm run build`." },
          ],
        };
      }
      const { text, lines } = await ocrScreen({
        region,
        displayIndex: display_index,
        fast,
        langs: lang,
      });
      if (include_coordinates) {
        return { content: [{ type: "text", text: JSON.stringify({ text, lines }, null, 2) }] };
      }
      return { content: [{ type: "text", text: text || "(no text recognized)" }] };
    },
  );

  server.registerTool(
    "get_clipboard",
    {
      title: "Read clipboard text",
      description: "Return the current text contents of the macOS clipboard (pbpaste).",
      inputSchema: {},
    },
    async () => {
      const text = await clipboardGet();
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "set_clipboard",
    {
      title: "Write clipboard text",
      description:
        "Set the macOS clipboard contents (pbcopy). Handy to paste long/Unicode text reliably with key 'cmd+v'.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => {
      await clipboardSet(text);
      return { content: [{ type: "text", text: `clipboard set (${text.length} chars)` }] };
    },
  );

  // -------------------------------------------------------------------------
  // A. Accessibility (AX) tree — structured UI perception & interaction.
  // -------------------------------------------------------------------------

  const axMatcher = {
    role: z.string().optional().describe('AX role substring, e.g. "AXButton", "AXTextField", "AXMenuItem".'),
    title: z.string().optional().describe("Title/label substring (case-insensitive)."),
    value: z.string().optional().describe("Current value substring (case-insensitive)."),
    index: z.number().int().nonnegative().optional().describe("Pick the Nth match (0-based, default 0)."),
    app: z.string().optional().describe("Target app by name/bundle id. Omit = frontmost app."),
  };
  const axAvailable = hasAx();
  const axGuard = () => ({
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: "AX helper (ax-helper) is not built. Run `npm run build` in computer-use-intel (needs Xcode swiftc) and grant Accessibility permission to Codex.",
      },
    ],
  });

  server.registerTool(
    "get_ui_elements",
    {
      title: "Read UI elements (Accessibility tree)",
      description:
        "Dump the macOS Accessibility tree of an app (frontmost by default) as a flat list of elements with " +
        "role, title, value, enabled state and the clickable screen-point center. Far more reliable than OCR for " +
        "'click the X button' tasks: read elements, then click_element or left_click the returned x,y. " +
        "Set actionable_only to keep just buttons/fields/menu items/links etc.",
      inputSchema: {
        app: z.string().optional(),
        actionable_only: z.boolean().optional().describe("Only return interactive elements (default false)."),
        max_nodes: z.number().int().positive().max(5000).optional().describe("Cap on returned elements."),
      },
    },
    async ({ app, actionable_only, max_nodes }) => {
      if (!axAvailable) return axGuard();
      const { count, elements } = await axDump({ app, actionableOnly: actionable_only, maxNodes: max_nodes });
      return { content: [{ type: "text", text: JSON.stringify({ count, elements }, null, 2) }] };
    },
  );

  server.registerTool(
    "find_element",
    {
      title: "Find UI elements (Accessibility)",
      description:
        "Search the Accessibility tree for elements matching role/title/value and return them with clickable " +
        "screen-point centers. Combine matchers to narrow down (e.g. role='AXButton', title='Save').",
      inputSchema: axMatcher,
    },
    async (m) => {
      if (!axAvailable) return axGuard();
      const { count, elements } = await axFind(m);
      return { content: [{ type: "text", text: JSON.stringify({ count, elements }, null, 2) }] };
    },
  );

  server.registerTool(
    "click_element",
    {
      title: "Click a UI element (Accessibility)",
      description:
        "Find a matching element and trigger it via the Accessibility press action (deterministic — no pixel " +
        "hunting). Falls back to a coordinate click if the element has no press action. Use matchers to target it.",
      inputSchema: axMatcher,
    },
    async (m) => {
      if (!axAvailable) return axGuard();
      const r = await axClick(m);
      return { content: [{ type: "text", text: `clicked element: ${JSON.stringify(r)}` }] };
    },
  );

  server.registerTool(
    "set_element_value",
    {
      title: "Set a UI element value (Accessibility)",
      description:
        "Set the value of a text field / control directly via the Accessibility API (no typing/focus needed). " +
        "Great for filling forms reliably. Target the field with role/title matchers.",
      inputSchema: {
        new_value: z.string().describe("The value to write into the element."),
        role: z.string().optional(),
        title: z.string().optional(),
        index: z.number().int().nonnegative().optional(),
        app: z.string().optional(),
      },
    },
    async ({ new_value, role, title, index, app }) => {
      if (!axAvailable) return axGuard();
      await axSetValue(new_value, { role, title, index, app });
      return { content: [{ type: "text", text: `set value (${new_value.length} chars)` }] };
    },
  );

  server.registerTool(
    "get_element_value",
    {
      title: "Read a UI element value (Accessibility)",
      description: "Return the role/title/value of the first element matching the given matchers.",
      inputSchema: axMatcher,
    },
    async (m) => {
      if (!axAvailable) return axGuard();
      const r = await axGetValue(m);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.registerTool(
    "click_menu_item",
    {
      title: "Click a menu bar item (Accessibility)",
      description:
        "Navigate the app's menu bar and trigger a menu item by path, e.g. path='File>Save' or " +
        "path='Format>Font>Bold'. Deterministic and far more robust than clicking menu pixels. " +
        "Targets the frontmost app unless 'app' is given.",
      inputSchema: {
        path: z.string().min(1).describe('Menu path separated by ">", e.g. "Edit>Find>Find…".'),
        app: z.string().optional(),
      },
    },
    async ({ path, app }) => {
      if (!axAvailable) return axGuard();
      await axMenu(path, app);
      return { content: [{ type: "text", text: `clicked menu: ${path}` }] };
    },
  );

  server.registerTool(
    "get_selected_text",
    {
      title: "Get selected text",
      description:
        "Return the currently selected text via the Accessibility API (falls back to cmd+c + clipboard if AX " +
        "yields nothing). Use to read what the user/agent has highlighted.",
      inputSchema: {},
    },
    async () => {
      const text = await getSelectedText();
      return { content: [{ type: "text", text: text || "(no selection)" }] };
    },
  );

  // -------------------------------------------------------------------------
  // C. Window & app management (Accessibility + open).
  // -------------------------------------------------------------------------

  server.registerTool(
    "list_windows",
    {
      title: "List windows of an app",
      description:
        "List an app's windows (frontmost app by default) with title, minimized state and on-screen frame " +
        "(x,y,w,h in points). Use the title or index with the window tools to target a specific window.",
      inputSchema: { app: z.string().optional() },
    },
    async ({ app }) => {
      if (!axAvailable) return axGuard();
      const wins = await axWindows(app);
      return { content: [{ type: "text", text: JSON.stringify({ count: wins.length, windows: wins }, null, 2) }] };
    },
  );

  const windowTarget = {
    app: z.string().optional().describe("Target app (frontmost by default)."),
    title: z.string().optional().describe("Match a window by title substring."),
    index: z.number().int().nonnegative().optional().describe("Window index (default 0)."),
  };

  server.registerTool(
    "focus_window",
    {
      title: "Raise & focus a window",
      description: "Raise a specific window of an app to the front and activate the app.",
      inputSchema: windowTarget,
    },
    async ({ app, title, index }) => {
      if (!axAvailable) return axGuard();
      await axWindowAction("focus", { app, title, index });
      return { content: [{ type: "text", text: "window focused" }] };
    },
  );

  server.registerTool(
    "move_window",
    {
      title: "Move a window",
      description: "Move a window so its top-left corner is at (x,y) in screen points.",
      inputSchema: { ...windowTarget, x: z.number().int(), y: z.number().int() },
    },
    async ({ app, title, index, x, y }) => {
      if (!axAvailable) return axGuard();
      await axWindowAction("move", { app, title, index, x, y });
      return { content: [{ type: "text", text: `window moved to ${x},${y}` }] };
    },
  );

  server.registerTool(
    "resize_window",
    {
      title: "Resize a window",
      description: "Resize a window to width x height (points).",
      inputSchema: {
        ...windowTarget,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      },
    },
    async ({ app, title, index, width, height }) => {
      if (!axAvailable) return axGuard();
      await axWindowAction("resize", { app, title, index, width, height });
      return { content: [{ type: "text", text: `window resized to ${width}x${height}` }] };
    },
  );

  server.registerTool(
    "minimize_window",
    {
      title: "Minimize / unminimize a window",
      description: "Minimize a window to the Dock, or restore it (set unminimize=true).",
      inputSchema: { ...windowTarget, unminimize: z.boolean().optional() },
    },
    async ({ app, title, index, unminimize }) => {
      if (!axAvailable) return axGuard();
      await axWindowAction(unminimize ? "unminimize" : "minimize", { app, title, index });
      return { content: [{ type: "text", text: unminimize ? "window restored" : "window minimized" }] };
    },
  );

  server.registerTool(
    "quit_app",
    {
      title: "Quit an app",
      description: "Gracefully quit an app by name (sends the standard Quit command).",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => {
      await quitApp(name);
      return { content: [{ type: "text", text: `quit ${name}` }] };
    },
  );

  server.registerTool(
    "hide_app",
    {
      title: "Hide an app",
      description: "Hide an app's windows (like Cmd+H) without quitting it.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => {
      await hideApp(name);
      return { content: [{ type: "text", text: `hid ${name}` }] };
    },
  );

  server.registerTool(
    "open_url",
    {
      title: "Open a URL",
      description: "Open a URL in the default browser (or registered handler).",
      inputSchema: { url: z.string().min(1) },
    },
    async ({ url }) => {
      await openUrl(url);
      return { content: [{ type: "text", text: `opened ${url}` }] };
    },
  );

  server.registerTool(
    "reveal_in_finder",
    {
      title: "Reveal a path in Finder",
      description: "Open Finder and select the given file or folder path.",
      inputSchema: { path: z.string().min(1) },
    },
    async ({ path }) => {
      await revealInFinder(path);
      return { content: [{ type: "text", text: `revealed ${path}` }] };
    },
  );

  // -------------------------------------------------------------------------
  // A2. Set-of-Marks annotated screenshot + pixel sampling.
  // -------------------------------------------------------------------------

  server.registerTool(
    "screenshot_annotated",
    {
      title: "Annotated screenshot (Set-of-Marks)",
      description:
        "Screenshot + on-device OCR with numbered red boxes drawn over every recognized text line. Returns the " +
        "annotated image plus a legend mapping each number to its text and clickable screen point. Workflow: " +
        "look at the image, pick a number, then left_click the legend's x,y. Great for dense UIs.",
      inputSchema: {
        region: regionSchema,
        display_index: z.number().int().nonnegative().optional(),
        fast: z.boolean().optional(),
        lang: z.array(z.string()).optional(),
        max_width: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Downscale the returned image to at most this width (default 1400)."),
      },
    },
    async ({ region, display_index, fast, lang, max_width }) => {
      if (!ocrAvailable) {
        return {
          isError: true,
          content: [{ type: "text", text: "OCR helper (vision-ocr) is not built. Run `npm run build`." }],
        };
      }
      const { base64, byteLength, marks, backend, geometry } = await annotateScreen({
        region,
        displayIndex: display_index,
        fast,
        langs: lang,
        maxWidth: max_width,
      });
      return {
        content: [
          { type: "image", data: base64, mimeType: "image/png", _meta: { "codex/imageDetail": "original" } },
          {
            type: "text",
            text:
              `Annotated ${byteLength} bytes (backend=${backend}). ` +
              `Geometry: ${JSON.stringify(geometry)}\n` +
              `Legend (index -> text @ screen-point x,y):\n${JSON.stringify(marks, null, 2)}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_pixel_color",
    {
      title: "Sample pixel color",
      description:
        "Return the RGB + hex color of a single screen pixel at (x,y). Useful for state detection (toggle on/off, " +
        "progress/loading indicators, theme). Requires the native Swift vision-ocr binary.",
      inputSchema: { x: z.number().int(), y: z.number().int() },
    },
    async ({ x, y }) => {
      const c = await getPixelColor(x, y);
      return { content: [{ type: "text", text: JSON.stringify({ x, y, ...c }) }] };
    },
  );

  // -------------------------------------------------------------------------
  // B. Deterministic input: modifier clicks, triple-click, hover, key hold, paste.
  // -------------------------------------------------------------------------

  server.registerTool(
    "click_modified",
    {
      title: "Click with modifier keys",
      description:
        "Click while holding modifier keys (cmd/ctrl/alt/shift/fn). Use for cmd+click (open in new tab/multi-select), " +
        "shift+click (range select), etc. 'button' supports left/right/middle/double/triple. " +
        "Coordinates optional (uses current cursor position if omitted).",
      inputSchema: {
        modifiers: z.array(z.enum(["cmd", "ctrl", "alt", "shift", "fn"])).min(1),
        button: z.enum(["left", "right", "middle", "double", "triple"]).optional().describe("Default left."),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
      },
    },
    async ({ modifiers, button, x, y }) => {
      await clickWithModifiers(button ?? "left", modifiers, x, y);
      return { content: [{ type: "text", text: `${(button ?? "left")}-click + [${modifiers.join("+")}]` }] };
    },
  );

  server.registerTool(
    "triple_click",
    {
      title: "Triple click",
      description: "Triple-click at a point (or current cursor) — selects a whole line/paragraph in most apps.",
      inputSchema: clickInput,
    },
    async ({ x, y }) => {
      await clickWithModifiers("triple", [], x, y);
      return { content: [{ type: "text", text: "triple_click ok" }] };
    },
  );

  server.registerTool(
    "hover",
    {
      title: "Hover the mouse",
      description:
        "Move the mouse to (x,y) and dwell, so hover-triggered UI (tooltips, hover menus, reveal-on-hover " +
        "controls) appears. Follow with a screenshot to see the result.",
      inputSchema: {
        x: z.number().int(),
        y: z.number().int(),
        dwell_ms: z.number().int().nonnegative().max(10_000).optional().describe("How long to dwell (default 600)."),
      },
    },
    async ({ x, y, dwell_ms }) => {
      await hover(x, y, dwell_ms ?? 600);
      return { content: [{ type: "text", text: `hovered ${x},${y}` }] };
    },
  );

  server.registerTool(
    "key_down",
    {
      title: "Press & hold a key/modifier",
      description:
        "Press and HOLD a key without releasing it (release later with key_up). With the CGEvent helper this works " +
        "for ANY key (e.g. 'w', 'space', 'arrow-up') — ideal for games / hold-to-move. Without it, only modifiers " +
        "(cmd/ctrl/alt/shift/fn) can be held via cliclick. 'modifiers' are applied as held flags alongside 'key'.",
      inputSchema: {
        key: z.string().optional().describe("Key name (e.g. 'w', 'space', 'arrow-up', 'f5') or virtual keycode."),
        modifiers: z.array(z.enum(["cmd", "ctrl", "alt", "shift", "fn"])).optional(),
      },
    },
    async ({ key, modifiers }) => {
      await keyDown({ key, modifiers });
      return { content: [{ type: "text", text: `holding ${[...(modifiers ?? []), key].filter(Boolean).join("+")}` }] };
    },
  );

  server.registerTool(
    "key_up",
    {
      title: "Release a held key/modifier",
      description: "Release a key/modifier previously held with key_down.",
      inputSchema: {
        key: z.string().optional(),
        modifiers: z.array(z.enum(["cmd", "ctrl", "alt", "shift", "fn"])).optional(),
      },
    },
    async ({ key, modifiers }) => {
      await keyUp({ key, modifiers });
      return { content: [{ type: "text", text: `released ${[...(modifiers ?? []), key].filter(Boolean).join("+")}` }] };
    },
  );

  server.registerTool(
    "key_tap",
    {
      title: "Tap a key (CGEvent)",
      description:
        "Press+release a key via real CGEvent HID events, optionally several times. Works in apps that ignore " +
        "AppleScript keystroke (games, some terminals/editors). Use 'key' (e.g. 'space', 'arrow-down', 'a') with " +
        "optional held modifiers. Requires the CGEvent helper (dist/cgevent).",
      inputSchema: {
        key: z.string().min(1).describe("Key name or virtual keycode."),
        modifiers: z.array(z.enum(["cmd", "ctrl", "alt", "shift", "fn"])).optional(),
        repeat: z.number().int().positive().max(500).optional().describe("How many taps (default 1)."),
        delay_ms: z.number().int().positive().max(5000).optional().describe("Delay between taps (default 20)."),
      },
    },
    async ({ key, modifiers, repeat, delay_ms }) => {
      if (!hasCgEvent()) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "CGEvent helper (cgevent) is not built. Run `npm run build` (needs Xcode swiftc).",
            },
          ],
        };
      }
      await keyTap(key, { modifiers, repeat, delayMs: delay_ms });
      return { content: [{ type: "text", text: `tapped ${key}${repeat ? ` x${repeat}` : ""}` }] };
    },
  );

  server.registerTool(
    "paste",
    {
      title: "Paste text",
      description:
        "Paste via Cmd+V. If 'text' is given, it is placed on the clipboard first — the most reliable way to enter " +
        "long or Unicode text into the focused field.",
      inputSchema: { text: z.string().optional().describe("Optional text to set on the clipboard before pasting.") },
    },
    async ({ text }) => {
      await paste(text);
      return { content: [{ type: "text", text: text != null ? `pasted ${text.length} chars` : "pasted clipboard" }] };
    },
  );

  // -------------------------------------------------------------------------
  // D. Robust agent loops: wait_for_text / wait_for_element / screen_changed.
  // -------------------------------------------------------------------------

  server.registerTool(
    "wait_for_text",
    {
      title: "Wait until text appears (OCR)",
      description:
        "Poll the screen with OCR until the query text appears or the timeout elapses. Returns whether it was found, " +
        "the elapsed time and the clickable coordinate of the first match. Use to wait for pages/dialogs to load " +
        "instead of blind waits.",
      inputSchema: {
        query: z.string().min(1),
        timeout_ms: z.number().int().positive().max(120_000).optional().describe("Default 10000."),
        interval_ms: z.number().int().positive().optional().describe("Poll interval, default 600."),
        region: regionSchema,
        regex: z.boolean().optional(),
        case_sensitive: z.boolean().optional(),
        lang: z.array(z.string()).optional(),
      },
    },
    async ({ query, timeout_ms, interval_ms, region, regex, case_sensitive, lang }) => {
      if (!ocrAvailable) {
        return {
          isError: true,
          content: [{ type: "text", text: "OCR helper (vision-ocr) is not built. Run `npm run build`." }],
        };
      }
      const r = await waitForText(query, {
        timeoutMs: timeout_ms,
        intervalMs: interval_ms,
        region,
        regex,
        caseSensitive: case_sensitive,
        langs: lang,
      });
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.registerTool(
    "wait_for_element",
    {
      title: "Wait until a UI element appears (Accessibility)",
      description:
        "Poll the Accessibility tree until an element matching role/title/value appears or the timeout elapses. " +
        "Returns the element (with clickable center) when found. More reliable than OCR polling for native UI.",
      inputSchema: {
        ...axMatcher,
        timeout_ms: z.number().int().positive().max(120_000).optional().describe("Default 10000."),
        interval_ms: z.number().int().positive().optional().describe("Poll interval, default 500."),
      },
    },
    async ({ role, title, value, index, app, timeout_ms, interval_ms }) => {
      if (!axAvailable) return axGuard();
      const r = await waitForElement(
        { role, title, value, index, app },
        { timeoutMs: timeout_ms, intervalMs: interval_ms },
      );
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.registerTool(
    "wait_for_screen_change",
    {
      title: "Wait until the screen changes",
      description:
        "Capture a baseline, then poll until the screen (or a region) visibly changes or the timeout elapses. " +
        "The baseline starts when this tool is called: it cannot prove that an earlier action changed the UI. " +
        "For action postconditions use act_and_observe with expect instead.",
      inputSchema: {
        region: regionSchema,
        timeout_ms: z.number().int().positive().max(120_000).optional().describe("Default 10000."),
        interval_ms: z.number().int().positive().optional().describe("Poll interval, default 500."),
      },
    },
    async ({ region, timeout_ms, interval_ms }) => {
      const r = await waitForScreenChange({ region, timeoutMs: timeout_ms, intervalMs: interval_ms });
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log a single startup line to stderr so Codex can confirm the server came up.
  process.stderr.write(
    `[computer-use-intel] ${SERVER_NAME} v${SERVER_VERSION} ready over stdio ` +
      `(pid ${process.pid}, ocr=${ocrBackend()}, ax=${hasAx() ? "on" : "off"}, cg=${hasCgEvent() ? "on" : "off"})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[computer-use-intel] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
