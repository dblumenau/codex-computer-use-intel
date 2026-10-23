import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { imagePointToScreen } from "./geometry.js";
import { clipToDisplay, currentDisplayLayout, resolveCaptureBounds, type CaptureOpts, type Region } from "./capture.js";
import { ScreenshotStore, performAndObserve } from "./workflow.js";
import { appIdentity, axDump, axWindows, axFind, axClick, click, pressKey, scroll,
  takeScreenshot, typeText, typingTimeoutMs, type AxMatch } from "./macos.js";

export const screenshots = new ScreenshotStore();
const region = z.object({ x: z.number().int(), y: z.number().int(),
  width: z.number().int().positive(), height: z.number().int().positive() });
export const captureTargetSchema = {
  app: z.string().min(1).optional().describe("Capture this app's window (name or bundle ID) without focusing it. Default: the frontmost app's window."),
  full_screen: z.boolean().optional().describe("Capture the whole display instead of one window. Costly on wide displays; use only when you need it."),
};
const matcher = z.object({ role: z.string().optional(), title: z.string().optional(),
  value: z.string().optional(), index: z.number().int().nonnegative().optional() })
  .refine(m => Boolean(m.role || m.title || m.value), "Supply role, title or value to identify an element.");

export type CaptureScope = { kind: "region" | "display" } | { kind: "window"; app: string; title: string };

/**
 * An app's focused window (main or first visible as fallbacks), clipped to the
 * display it sits on. Undefined when the app has no visible window or AX cannot
 * read it.
 */
export async function appWindowRegion(pid: number): Promise<{ region: Region; title: string } | undefined> {
  try {
    const wins = (await axWindows(undefined, pid)).filter(w => !w.minimized && w.frame.w > 0 && w.frame.h > 0);
    const win = wins.find(w => w.focused) ?? wins.find(w => w.main) ?? wins[0];
    if (!win) return undefined;
    const region = await clipToDisplay({ x: win.frame.x, y: win.frame.y, width: win.frame.w, height: win.frame.h });
    return region && { region, title: win.title };
  } catch {
    return undefined;
  }
}

/**
 * Capture target for image-returning tools: an explicit region or display wins,
 * `fullScreen` asks for the display, otherwise the target app's window. Without
 * a named app a windowless frontmost app falls back to the display.
 */
export async function resolveScope(opts: { region?: Region; displayIndex?: number; fullScreen?: boolean; app?: string },
  target: { pid: number; name: string }): Promise<{ region?: Region; scope: CaptureScope }> {
  if (opts.region) return { region: opts.region, scope: { kind: "region" } };
  if (opts.fullScreen || opts.displayIndex !== undefined) return { scope: { kind: "display" } };
  const win = await appWindowRegion(target.pid);
  if (win) return { region: win.region, scope: { kind: "window", app: target.name, title: win.title } };
  if (opts.app) throw new Error(`${target.name} has no visible window to capture. Pass full_screen or region instead.`);
  return { scope: { kind: "display" } };
}

export async function captureObservation(opts: CaptureOpts & { app?: string; fullScreen?: boolean;
  includeUi?: boolean; maxElements?: number } = {}) {
  const before = await appIdentity();
  const target = opts.app ? await appIdentity(opts.app) : before;
  const { region, scope } = await resolveScope(opts, target);
  const shot = await takeScreenshot({ ...opts, region, showCursor: opts.showCursor ?? true });
  const frontmost = await appIdentity();
  if (before.pid !== frontmost.pid) throw new Error("Frontmost app changed during capture. Observe again.");
  const metadata = {
    screenshot_id: screenshots.add(shot.geometry, target.pid),
    captureScope: scope,
    ...shot.geometry,
    frontmostApp: frontmost,
    byteLength: shot.byteLength,
    coordinateNote: "Image pixels map through imageToScreen. AX/OCR positions are already screen points. References expire after 120 seconds or any input through this server; external UI changes still require a fresh observation.",
  };
  let ui: unknown;
  let uiError: string | undefined;
  if (opts.includeUi) {
    try {
      const dump = await axDump({ pid: target.pid, maxNodes: 1500 });
      const b = shot.geometry.screenBoundsPoints;
      const visible = dump.elements.filter(e => e.frame.w > 0 && e.frame.h > 0 &&
        e.frame.x < b.x + b.width && e.frame.x + e.frame.w > b.x &&
        e.frame.y < b.y + b.height && e.frame.y + e.frame.h > b.y &&
        (e.actionable || ["AXHeading", "AXStaticText"].includes(e.role)));
      const limit = opts.maxElements ?? 120;
      ui = { returned: Math.min(visible.length, limit), matchedInScan: visible.length,
        truncated: visible.length > limit || dump.count >= 1500,
        elements: visible.slice(0, limit).map(e => ({ ...e, title: e.title.slice(0, 250), value: e.value.slice(0, 250) })) };
    } catch (error) { uiError = String(error); }
  }
  return { metadata, base64: shot.base64, ...(ui ? { ui } : {}), ...(uiError ? { uiError } : {}) };
}

export function observationResult(observation: Awaited<ReturnType<typeof captureObservation>>) {
  const { base64, ...state } = observation;
  return {
    content: [
      { type: "image" as const, data: base64, mimeType: "image/png", _meta: { "codex/imageDetail": "original" } },
      { type: "text" as const, text: JSON.stringify(state) },
    ],
    structuredContent: state,
  };
}

export function registerPerceptionTools(server: McpServer) {
  server.registerTool("get_desktop_state", {
    title: "Observe desktop with screenshot geometry and UI state",
    description: "Get a screenshot of the frontmost window (or another app's window, the full display or an explicit region), exact image-pixel-to-screen-point mapping, frontmost app identity and compact visible Accessibility elements of the captured app. Use before visual actions. Crop with region for small text; no need to mentally scale coordinates.",
    inputSchema: { region: region.optional(), ...captureTargetSchema, max_width: z.number().int().positive().max(8192).optional(),
      include_ui: z.boolean().optional(), max_elements: z.number().int().positive().max(250).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ region, app, full_screen, max_width, include_ui, max_elements }) => observationResult(await captureObservation({
    region, app, fullScreen: full_screen, maxWidth: max_width ?? 1400, includeUi: include_ui ?? true, maxElements: max_elements,
  })));

  server.registerTool("act_and_observe", {
    title: "Perform one action, check a postcondition and observe",
    description: "Perform exactly one desktop action, optionally wait for an expected Accessibility element/value, then return a fresh screenshot and UI state. Image clicks use screenshot_id plus image-pixel x/y; without screenshot_id click x/y are screen points. App must already be frontmost. An action receipt alone is not success: inspect verification and observation. Never automatically repeat a timed-out or uncertain action. A pre-existing postcondition skips input. Coordinate method is an explicit alternative when AXPress had no visible effect.",
    inputSchema: {
      app: z.string().min(1).describe("Expected frontmost running app name or bundle ID; focus_app first if necessary."),
      action: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("click"), x: z.number().nonnegative(), y: z.number().nonnegative(),
          screenshot_id: z.string().optional(), button: z.enum(["left", "right", "double"]).optional() }),
        z.object({ kind: z.literal("click_element"), target: matcher,
          method: z.enum(["press", "coordinate"]).optional() }),
        z.object({ kind: z.literal("type"), text: z.string().max(20_000) }),
        z.object({ kind: z.literal("key"), keys: z.string().min(1) }),
        z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]),
          amount: z.number().int().positive().max(2000), pixels: z.boolean().optional() }),
      ]),
      expect: z.object({ target: matcher, present: z.boolean().optional(), exact_value: z.string().optional() }).optional()
        .describe("Checks the target app's Accessibility tree. present defaults true. exact_value uses equality, not substring. Already satisfied conditions skip input."),
      timeout_ms: z.number().int().nonnegative().max(15_000).optional().describe("Postcondition polling budget; default 5000. A single OS call may extend it."),
      region: region.optional().describe("Region for the returned screenshot; global screen points. Default: the frontmost window."),
      full_screen: captureTargetSchema.full_screen,
      max_width: z.number().int().positive().max(8192).optional(),
      include_ui: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ app, action, expect, timeout_ms, region, full_screen, max_width, include_ui }) => {
    const target = await appIdentity(app);
    const checkFocus = async () => {
      if ((await appIdentity()).pid !== target.pid) throw new Error("Frontmost app differs from the requested app. Observe and focus it before acting.");
    };
    await checkFocus();
    if (action.kind === "type") typingTimeoutMs(action.text);
    let point: { x: number; y: number } | undefined;
    if (action.kind === "click") {
      if (action.screenshot_id) {
        const previous = screenshots.get(action.screenshot_id);
        if (previous.appPid !== target.pid) throw new Error("Screenshot belongs to a different frontmost app. Take a new screenshot.");
        if (previous.geometry.displayLayout !== await currentDisplayLayout()) {
          throw new Error("Display layout changed since the screenshot. Take a fresh screenshot.");
        }
        // Also reject a region that is no longer on an active display.
        await resolveCaptureBounds({ region: previous.geometry.screenBoundsPoints });
        point = imagePointToScreen(previous.geometry, action.x, action.y);
      } else {
        if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) throw new Error("Screen-point clicks must use integer x/y.");
        await resolveCaptureBounds({ region: { x: action.x, y: action.y, width: 1, height: 1 } });
        point = { x: action.x, y: action.y };
      }
    }
    const matches = expect ? async () => {
      const r = await axFind({ ...expect.target, pid: target.pid });
      const found = r.elements.some(e => e.frame.w > 0 && e.frame.h > 0 &&
        (expect.exact_value === undefined || e.value === expect.exact_value));
      return (expect.present ?? true) ? found : !found;
    } : undefined;
    const result = await performAndObserve({
      matches, timeoutMs: timeout_ms,
      dispatch: async () => {
        await checkFocus();
        screenshots.invalidate();
        switch (action.kind) {
          case "click": await click(action.button ?? "left", point!.x, point!.y); break;
          case "click_element": {
            const m: AxMatch = { ...action.target, pid: target.pid };
            const r = await axFind(m);
            if (!r.elements.length) throw new Error("Target element not found.");
            if (r.count > 1 && action.target.index === undefined) throw new Error("Multiple elements match. Narrow the target or choose an explicit index.");
            const e = r.elements[0];
            if (!e.enabled || e.frame.w <= 0 || e.frame.h <= 0) throw new Error("Target element is disabled or has no visible frame.");
            if (action.method === "coordinate") {
              await resolveCaptureBounds({ region: { x: e.x, y: e.y, width: 1, height: 1 } });
              await click("left", e.x, e.y);
            } else await axClick(m, { coordinateFallback: false });
            break;
          }
          case "type": await typeText(action.text); break;
          case "key": await pressKey(action.keys); break;
          case "scroll": await scroll(action.direction, action.amount, undefined, { pixels: action.pixels }); break;
        }
      },
      observe: () => captureObservation({ region, fullScreen: full_screen, maxWidth: max_width ?? 1400, includeUi: include_ui ?? true }),
    });
    const { observation, ...receipt } = result;
    const state = { ...receipt, action: { kind: action.kind, ...receipt.action },
      ...(observation ? { observation: { ...observation, base64: undefined } } : {}) };
    return { content: [
      { type: "text" as const, text: JSON.stringify(state) },
      ...(observation ? [{ type: "image" as const, data: observation.base64, mimeType: "image/png",
        _meta: { "codex/imageDetail": "original" } }] : []),
    ], structuredContent: state };
  });
}
