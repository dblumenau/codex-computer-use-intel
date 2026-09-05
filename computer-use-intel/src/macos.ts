import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureImageToFile, resolveCaptureBounds, type CaptureOpts } from "./capture.js";
import { geometryFrom, readPngSize, type CaptureGeometry } from "./geometry.js";

/**
 * Low-level macOS automation primitives for x86_64 Intel Macs.
 *
 * All operations go through built-in macOS CLIs + cliclick so that no arm64
 * dependencies are required. Each wrapper returns Promises and surfaces
 * stderr as Error for clean MCP error propagation.
 */

const CLICLICK = "/usr/local/bin/cliclick";
const OSASCRIPT = "/usr/bin/osascript";
const OPEN = "/usr/bin/open";
const PBCOPY = "/usr/bin/pbcopy";
const PBPASTE = "/usr/bin/pbpaste";
const SIPS = "/usr/bin/sips";

// OCR uses Apple's Vision framework. Primary path is a native x86_64 Swift
// binary (dist/vision-ocr, compiled with the full Xcode toolchain). If that
// binary is missing, we fall back to the PyObjC bridge (src/ocr.py in the
// project venv) which produces the identical JSON contract. Paths are resolved
// relative to dist/.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OCR_BIN = join(dirname(fileURLToPath(import.meta.url)), "vision-ocr");
const OCR_PYTHON = join(PROJECT_ROOT, ".venv", "bin", "python3");
const OCR_SCRIPT = join(PROJECT_ROOT, "src", "ocr.py");

// Accessibility helper (native x86_64 Swift binary, dist/ax-helper). Provides
// structured UI-tree access, menu navigation and window control via the macOS
// Accessibility API. Requires Accessibility permission on the host process.
const AX_BIN = join(dirname(fileURLToPath(import.meta.url)), "ax-helper");

export function hasAx(): boolean {
  return existsSync(AX_BIN);
}

// CGEvent helper (native x86_64 Swift binary, dist/cgevent). Posts real
// CoreGraphics HID events for precise scrolling and arbitrary key hold/tap.
const CG_BIN = join(dirname(fileURLToPath(import.meta.url)), "cgevent");

export function hasCgEvent(): boolean {
  return existsSync(CG_BIN);
}

type OcrBackend =
  | { kind: "swift"; cmd: string; baseArgs: string[] }
  | { kind: "python"; cmd: string; baseArgs: string[] };

/** Resolve the OCR backend, preferring the native Swift binary. */
function resolveOcrBackend(): OcrBackend | null {
  if (existsSync(OCR_BIN)) {
    return { kind: "swift", cmd: OCR_BIN, baseArgs: [] };
  }
  if (existsSync(OCR_PYTHON) && existsSync(OCR_SCRIPT)) {
    return { kind: "python", cmd: OCR_PYTHON, baseArgs: [OCR_SCRIPT] };
  }
  return null;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

function runCapture(cmd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timeout after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

export async function cliclick(...segments: string[]): Promise<string> {
  return runCapture(CLICLICK, ["-m", "verbose", ...segments]);
}

export async function osa(script: string): Promise<string> {
  return runCapture(OSASCRIPT, ["-e", script]);
}

export async function open(appName: string, extraArgs: string[] = []): Promise<void> {
  await runCapture(OPEN, ["-a", appName, ...extraArgs]);
}

/** Downscale a PNG in place to at most maxWidth px (skips upscaling). */
async function maybeDownscale(path: string, maxWidth?: number): Promise<void> {
  if (!maxWidth || maxWidth <= 0) return;
  try {
    const info = await runCapture(SIPS, ["-g", "pixelWidth", path], 10_000);
    const m = info.match(/pixelWidth:\s*(\d+)/);
    if (m && parseInt(m[1], 10) > maxWidth) {
      await runCapture(SIPS, ["--resampleWidth", String(maxWidth), path], 10_000);
    }
  } catch {
    // Non-fatal: keep the full-resolution capture if sips fails.
  }
}

/**
 * Capture a PNG to a temp file and return its path. Caller is responsible for
 * deleting the file. Shared by takeScreenshot (base64) and the OCR helpers.
 */
export async function captureToFile(opts: CaptureOpts): Promise<string> {
  return (await captureImageToFile(opts)).path;
}

export async function takeScreenshot(opts: CaptureOpts): Promise<{
  base64: string;
  byteLength: number;
  path: string;
  geometry: CaptureGeometry;
}> {
  const { path: tmp, geometry } = await captureImageToFile(opts);
  try {
    const buf = readFileSync(tmp);
    return { base64: buf.toString("base64"), byteLength: buf.byteLength, path: tmp, geometry };
  } finally { try { unlinkSync(tmp); } catch {} }
}

export interface OcrLine {
  text: string;
  confidence: number;
  cx: number; // box center, normalized 0..1, top-left origin
  cy: number;
  w: number;
  h: number;
}

export interface OcrResult {
  width: number;
  height: number;
  lines: OcrLine[];
}

export function hasOcr(): boolean {
  return resolveOcrBackend() !== null;
}

/** Which OCR backend is active ("swift", "python", or "none"). */
export function ocrBackend(): "swift" | "python" | "none" {
  return resolveOcrBackend()?.kind ?? "none";
}

/** Run the Vision OCR helper on an image file and return raw normalized lines. */
export async function ocrImage(
  imagePath: string,
  langs?: string[],
  fast = false,
): Promise<OcrResult> {
  const backend = resolveOcrBackend();
  if (!backend) {
    throw new Error(
      `OCR helper not set up (expected ${OCR_BIN} or ${OCR_PYTHON} + ${OCR_SCRIPT}). Run: npm run build:ocr`,
    );
  }
  const args = [...backend.baseArgs, imagePath];
  if (langs && langs.length) args.push("--lang", langs.join(","));
  if (fast) args.push("--fast");
  const out = await runCapture(backend.cmd, args, 30_000);
  return JSON.parse(out) as OcrResult;
}

export interface TextMatch {
  text: string;
  confidence: number;
  x: number; // screen point (top-left origin)
  y: number;
}

interface FindOpts {
  region?: Region;
  displayIndex?: number;
  regex?: boolean;
  caseSensitive?: boolean;
  fast?: boolean;
  langs?: string[];
}

/** Map a normalized OCR line center onto absolute screen points. */
async function mapToScreen(
  lines: OcrLine[],
  region: Region,
): Promise<{ text: string; confidence: number; x: number; y: number }[]> {
  let ox = 0;
  let oy = 0;
  let sw: number;
  let sh: number;
  if (region) {
    ox = region.x;
    oy = region.y;
    sw = region.width;
    sh = region.height;
  } else {
    const s = await getScreenSize();
    sw = s.width;
    sh = s.height;
  }
  return lines.map((ln) => ({
    text: ln.text,
    confidence: Math.round(ln.confidence * 1000) / 1000,
    x: Math.round(ox + ln.cx * sw),
    y: Math.round(oy + ln.cy * sh),
  }));
}

/**
 * Screenshot + OCR + search. Returns every matching line with the clickable
 * screen-point center of its bounding box, ordered by reading order then
 * confidence.
 */
export async function findText(
  query: string,
  opts: FindOpts = {},
): Promise<{ matches: TextMatch[]; lineCount: number }> {
  const { path: tmp, geometry } = await captureImageToFile({ region: opts.region, displayIndex: opts.displayIndex });
  try {
    const res = await ocrImage(tmp, opts.langs, opts.fast ?? false);
    const mapped = await mapToScreen(res.lines, geometry.screenBoundsPoints);
    const re = opts.regex
      ? new RegExp(query, opts.caseSensitive ? "" : "i")
      : null;
    const matches: TextMatch[] = [];
    for (const m of mapped) {
      let ok: boolean;
      if (re) {
        ok = re.test(m.text);
      } else if (opts.caseSensitive) {
        ok = m.text.includes(query);
      } else {
        ok = m.text.toLowerCase().includes(query.toLowerCase());
      }
      if (ok) matches.push(m);
    }
    return { matches, lineCount: res.lines.length };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/** Screenshot + OCR of the whole screen (or a region). Returns all text + per-line coords. */
export async function ocrScreen(
  opts: { region?: Region; displayIndex?: number; fast?: boolean; langs?: string[] } = {},
): Promise<{ text: string; lines: TextMatch[] }> {
  const { path: tmp, geometry } = await captureImageToFile({ region: opts.region, displayIndex: opts.displayIndex });
  try {
    const res = await ocrImage(tmp, opts.langs, opts.fast ?? false);
    const lines = await mapToScreen(res.lines, geometry.screenBoundsPoints);
    return { text: lines.map((l) => l.text).join("\n"), lines };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Accessibility (AX) tree: structured UI perception & interaction.
// ---------------------------------------------------------------------------

export interface AxMatch {
  app?: string;
  pid?: number;
  role?: string;
  title?: string;
  value?: string;
  index?: number;
}

export interface AxElement {
  index: number;
  role: string;
  title: string;
  value: string;
  enabled: boolean;
  actionable: boolean;
  x: number; // clickable center, screen points
  y: number;
  frame: { x: number; y: number; w: number; h: number };
}

function appArgs(m: { app?: string; pid?: number }): string[] {
  const a: string[] = [];
  if (m.app) a.push("--app", m.app);
  if (m.pid != null) a.push("--pid", String(m.pid));
  return a;
}

function matchArgs(m: AxMatch): string[] {
  const a = appArgs(m);
  if (m.role) a.push("--role", m.role);
  if (m.title) a.push("--title", m.title);
  if (m.value) a.push("--value", m.value);
  if (m.index != null) a.push("--index", String(m.index));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runAx(args: string[], timeoutMs = 15_000): Promise<any> {
  if (!hasAx()) {
    throw new Error(`AX helper not built (expected ${AX_BIN}). Run: npm run build:ax`);
  }
  const out = await runCapture(AX_BIN, args, timeoutMs);
  const j = JSON.parse(out);
  if (j && j.ok === false) throw new Error(`ax-helper: ${j.error}`);
  return j;
}

export async function axDump(
  opts: { app?: string; pid?: number; actionableOnly?: boolean; maxNodes?: number } = {},
): Promise<{ count: number; elements: AxElement[] }> {
  const args = ["dump", ...appArgs(opts)];
  if (opts.actionableOnly) args.push("--actionable-only");
  if (opts.maxNodes) args.push("--max-nodes", String(opts.maxNodes));
  const j = await runAx(args);
  return { count: j.count, elements: j.elements };
}

export async function axFind(m: AxMatch): Promise<{ count: number; elements: AxElement[] }> {
  const j = await runAx(["find", ...matchArgs(m)]);
  if (m.index !== undefined) {
    const element = j.elements[m.index];
    return { count: element ? 1 : 0, elements: element ? [element] : [] };
  }
  return { count: j.count, elements: j.elements };
}

export async function axClick(m: AxMatch, opts: { coordinateFallback?: boolean } = {}): Promise<AxElement> {
  const j = await runAx(["click", ...matchArgs(m)]);
  // ax-helper either AXPresses (j.pressed) or reports center coords to click.
  if (j.pressFailed && j.center) {
    if (opts.coordinateFallback === false) {
      throw new Error("AXPress returned an error; input outcome is uncertain. No coordinate fallback was sent. Inspect the new state before choosing another action.");
    }
    await click("left", j.center.x, j.center.y);
    return { ...(j as object), x: j.center.x, y: j.center.y } as unknown as AxElement;
  }
  return j.pressed as AxElement;
}

export async function axSetValue(value: string, m: AxMatch): Promise<void> {
  await runAx(["setvalue", "--value", value, ...matchArgs({ ...m, value: undefined })]);
}

export async function axGetValue(
  m: AxMatch,
): Promise<{ role: string; title: string; value: string }> {
  return runAx(["getvalue", ...matchArgs(m)]);
}

export async function axMenu(path: string, app?: string): Promise<void> {
  const args = ["menu", "--path", path];
  if (app) args.push("--app", app);
  await runAx(args, 8_000);
}

export interface AxWindow {
  index: number;
  title: string;
  minimized: boolean;
  frame: { x: number; y: number; w: number; h: number };
}

export async function axWindows(app?: string): Promise<AxWindow[]> {
  const j = await runAx(["windows", ...appArgs({ app })]);
  return j.windows as AxWindow[];
}

export async function axWindowAction(
  action: "focus" | "move" | "resize" | "minimize" | "unminimize",
  opts: { app?: string; title?: string; index?: number; x?: number; y?: number; width?: number; height?: number },
): Promise<void> {
  const args = ["window", "--action", action, ...appArgs(opts)];
  if (opts.title) args.push("--title", opts.title);
  if (opts.index != null) args.push("--index", String(opts.index));
  if (opts.x != null) args.push("--x", String(opts.x));
  if (opts.y != null) args.push("--y", String(opts.y));
  if (opts.width != null) args.push("--width", String(opts.width));
  if (opts.height != null) args.push("--height", String(opts.height));
  await runAx(args);
}

export async function getSelectedText(): Promise<string> {
  if (hasAx()) {
    try {
      const r = await runAx(["selected-text"]);
      if (r.text) return r.text as string;
    } catch {
      // fall through to clipboard method
    }
  }
  // Fallback clobbers the clipboard, so only used when AX yields nothing.
  await pressKey("cmd+c");
  await sleep(150);
  return clipboardGet().catch(() => "");
}

// ---------------------------------------------------------------------------
// Set-of-Marks annotated screenshot + pixel sampling.
// ---------------------------------------------------------------------------

export interface Mark {
  index: number;
  text: string;
  x: number;
  y: number;
}

/**
 * Screenshot with numbered boxes drawn over every OCR'd line (Set-of-Marks).
 * Returns the annotated PNG (base64) plus the index->{text,x,y} legend so the
 * model can refer to a number and we click the matching screen point.
 */
export async function annotateScreen(
  opts: { region?: Region; displayIndex?: number; fast?: boolean; langs?: string[]; maxWidth?: number } = {},
): Promise<{ base64: string; byteLength: number; marks: Mark[]; backend: string; geometry: CaptureGeometry }> {
  const backend = resolveOcrBackend();
  if (!backend) throw new Error("OCR backend not set up; cannot annotate.");
  const { path: tmp, geometry } = await captureImageToFile({ region: opts.region, displayIndex: opts.displayIndex });
  const annot = tmp.replace(/\.png$/, "-annot.png");
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let res: any;
    if (backend.kind === "swift") {
      const args = [tmp, "--annotate", annot];
      if (opts.langs?.length) args.push("--lang", opts.langs.join(","));
      if (opts.fast) args.push("--fast");
      res = JSON.parse(await runCapture(backend.cmd, args, 30_000));
    } else {
      // PyObjC fallback can't draw boxes; return the raw screenshot with marks.
      res = await ocrImage(tmp, opts.langs, opts.fast ?? false);
    }
    const imgPath: string = res.annotated || tmp;
    await maybeDownscale(imgPath, opts.maxWidth ?? 1400);
    const buf = readFileSync(imgPath);
    const mapped = await mapToScreen(res.lines, geometry.screenBoundsPoints);
    const marks: Mark[] = mapped.map((l, i) => ({ index: i, text: l.text, x: l.x, y: l.y }));
    return { base64: buf.toString("base64"), byteLength: buf.byteLength, marks, backend: backend.kind,
      geometry: geometryFrom(geometry.screenBoundsPoints, readPngSize(buf), geometry.capturedAt) };
  } finally {
    for (const p of [tmp, annot]) {
      try {
        unlinkSync(p);
      } catch {}
    }
  }
}

export async function getPixelColor(
  x: number,
  y: number,
): Promise<{ r: number; g: number; b: number; hex: string }> {
  const backend = resolveOcrBackend();
  if (backend?.kind !== "swift") {
    throw new Error("Pixel sampling requires the native Swift vision-ocr binary.");
  }
  const tmp = await captureToFile({ region: { x, y, width: 1, height: 1 } });
  try {
    const out = await runCapture(backend.cmd, ["pixel", tmp], 10_000);
    const j = JSON.parse(out);
    return { r: j.r, g: j.g, b: j.b, hex: j.hex };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Deterministic input: modifier clicks, triple-click, hover, key hold, paste.
// ---------------------------------------------------------------------------

function normalizeMod(m: string): string {
  const lc = m.toLowerCase();
  if (lc === "cmd" || lc === "command" || lc === "meta") return "cmd";
  if (lc === "ctrl" || lc === "control") return "ctrl";
  if (lc === "alt" || lc === "opt" || lc === "option") return "alt";
  if (lc === "shift") return "shift";
  if (lc === "fn") return "fn";
  throw new Error(`Unknown modifier: ${m} (use cmd/ctrl/alt/shift/fn)`);
}

export async function clickWithModifiers(
  kind: "left" | "right" | "middle" | "double" | "triple",
  modifiers: string[] = [],
  x?: number,
  y?: number,
): Promise<void> {
  const target = x !== undefined && y !== undefined ? `${x},${y}` : ".";
  const op =
    kind === "left" ? "c" : kind === "right" ? "rc" : kind === "middle" ? "mc" : kind === "double" ? "dc" : "tc";
  const mods = modifiers.map(normalizeMod);
  const segs: string[] = [];
  if (mods.length) segs.push(`kd:${mods.join(",")}`);
  segs.push(`${op}:${target}`);
  if (mods.length) segs.push(`ku:${mods.join(",")}`);
  await cliclick(...segs);
}

export async function hover(x: number, y: number, dwellMs = 600): Promise<void> {
  await moveCursor(x, y);
  await sleep(dwellMs);
}

interface KeyHold {
  key?: string;
  modifiers?: string[];
}

async function cgKey(action: "keydown" | "keyup", k: KeyHold): Promise<void> {
  const args: string[] = [action];
  if (k.key) args.push("--key", k.key);
  else if (k.modifiers?.length) args.push("--key", k.modifiers[0]);
  else throw new Error(`${action} requires a key or modifier`);
  // Extra modifiers (beyond the primary key) are applied as event flags.
  const extraMods = k.key ? k.modifiers ?? [] : (k.modifiers ?? []).slice(1);
  if (extraMods.length) args.push("--mods", extraMods.join(","));
  await runCapture(CG_BIN, args, 8_000);
}

/**
 * Press & hold a key (any key when the CGEvent helper is present; modifier-only
 * via cliclick otherwise). A held key stays down until keyUp is called.
 */
export async function keyDown(k: KeyHold): Promise<void> {
  if (hasCgEvent() && k.key) return cgKey("keydown", k);
  const mods = k.modifiers ?? [];
  if (!mods.length) {
    if (k.key) throw new Error("Holding non-modifier keys requires the CGEvent helper (dist/cgevent).");
    throw new Error("keyDown requires a key or modifier");
  }
  if (hasCgEvent()) return cgKey("keydown", { modifiers: mods });
  await cliclick(`kd:${mods.map(normalizeMod).join(",")}`);
}

export async function keyUp(k: KeyHold): Promise<void> {
  if (hasCgEvent() && k.key) return cgKey("keyup", k);
  const mods = k.modifiers ?? [];
  if (!mods.length) {
    if (k.key) throw new Error("Releasing non-modifier keys requires the CGEvent helper (dist/cgevent).");
    throw new Error("keyUp requires a key or modifier");
  }
  if (hasCgEvent()) return cgKey("keyup", { modifiers: mods });
  await cliclick(`ku:${mods.map(normalizeMod).join(",")}`);
}

/**
 * Tap (press+release) an arbitrary key via CGEvent, optionally several times.
 * Works in apps that ignore AppleScript keystroke (games, some terminals).
 */
export async function keyTap(
  key: string,
  opts: { modifiers?: string[]; repeat?: number; delayMs?: number } = {},
): Promise<void> {
  if (!hasCgEvent()) throw new Error(`CGEvent helper not built (expected ${CG_BIN}).`);
  const args = ["tap", "--key", key];
  if (opts.modifiers?.length) args.push("--mods", opts.modifiers.join(","));
  if (opts.repeat) args.push("--repeat", String(opts.repeat));
  if (opts.delayMs != null) args.push("--delay-ms", String(opts.delayMs));
  await runCapture(CG_BIN, args, 15_000);
}

export async function paste(text?: string): Promise<void> {
  if (text != null) await clipboardSet(text);
  await pressKey("cmd+v");
}

// ---------------------------------------------------------------------------
// App & window conveniences.
// ---------------------------------------------------------------------------

export async function quitApp(name: string): Promise<void> {
  await osa(`tell application ${asJSONString(name)} to quit`);
}

export async function hideApp(name: string): Promise<void> {
  await osa(
    `tell application "System Events" to set visible of (first process whose name is ${asJSONString(name)}) to false`,
  );
}

export async function openUrl(url: string): Promise<void> {
  await runCapture(OPEN, [url]);
}

export async function revealInFinder(path: string): Promise<void> {
  await runCapture(OPEN, ["-R", path]);
}

// ---------------------------------------------------------------------------
// Robust agent loops: wait_for_text / wait_for_element / screen_changed.
// ---------------------------------------------------------------------------

export async function waitForText(
  query: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    region?: Region;
    regex?: boolean;
    caseSensitive?: boolean;
    langs?: string[];
  } = {},
): Promise<{ found: boolean; elapsedMs: number; match?: TextMatch; matches?: TextMatch[]; lineCount?: number }> {
  const timeout = opts.timeoutMs ?? 10_000;
  const interval = opts.intervalMs ?? 600;
  const start = Date.now();
  let lineCount = 0;
  for (;;) {
    const r = await findText(query, {
      region: opts.region,
      regex: opts.regex,
      caseSensitive: opts.caseSensitive,
      fast: true,
      langs: opts.langs,
    });
    lineCount = r.lineCount;
    if (r.matches.length) {
      return { found: true, elapsedMs: Date.now() - start, match: r.matches[0], matches: r.matches };
    }
    if (Date.now() - start >= timeout) {
      return { found: false, elapsedMs: Date.now() - start, lineCount };
    }
    await sleep(interval);
  }
}

export async function waitForElement(
  m: AxMatch,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ found: boolean; elapsedMs: number; element?: AxElement }> {
  const timeout = opts.timeoutMs ?? 10_000;
  const interval = opts.intervalMs ?? 500;
  const start = Date.now();
  for (;;) {
    try {
      const r = await axFind(m);
      if (r.count > 0) return { found: true, elapsedMs: Date.now() - start, element: r.elements[0] };
    } catch {
      // ignore transient AX errors while polling
    }
    if (Date.now() - start >= timeout) return { found: false, elapsedMs: Date.now() - start };
    await sleep(interval);
  }
}

export async function waitForScreenChange(
  opts: { region?: Region; timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ changed: boolean; elapsedMs: number }> {
  const timeout = opts.timeoutMs ?? 10_000;
  const interval = opts.intervalMs ?? 500;
  const start = Date.now();
  const hashNow = async (): Promise<string> => {
    const t = await captureToFile({ region: opts.region, maxWidth: 400 });
    try {
      return createHash("sha1").update(readFileSync(t)).digest("hex");
    } finally {
      try {
        unlinkSync(t);
      } catch {}
    }
  };
  const baseline = await hashNow();
  for (;;) {
    await sleep(interval);
    const cur = await hashNow();
    if (cur !== baseline) return { changed: true, elapsedMs: Date.now() - start };
    if (Date.now() - start >= timeout) return { changed: false, elapsedMs: Date.now() - start };
  }
}

export async function clipboardGet(): Promise<string> {
  return runCapture(PBPASTE, []);
}

export async function clipboardSet(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(PBCOPY, [], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}: ${stderr.trim()}`)),
    );
    child.stdin.write(text);
    child.stdin.end();
  });
}

export async function getScreenSize(): Promise<{ width: number; height: number }> {
  const { width, height } = await resolveCaptureBounds({});
  return { width, height };
}

export async function getCursorPosition(): Promise<{ x: number; y: number }> {
  const out = await cliclick("p:.");
  const m = out.match(/(-?\d+),(-?\d+)/);
  if (!m) throw new Error(`Could not parse cursor position: ${out}`);
  return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
}

export async function moveCursor(x: number, y: number): Promise<void> {
  await cliclick(`m:${x},${y}`);
}

export async function click(
  kind: "left" | "right" | "middle" | "double",
  x?: number,
  y?: number,
): Promise<void> {
  if (hasCgEvent()) {
    const point = x !== undefined && y !== undefined ? { x, y } : await getCursorPosition();
    const r = JSON.parse(await runCapture(CG_BIN, ["click", "--x", String(point.x), "--y", String(point.y), "--button", kind]));
    if (!r.ok) throw new Error(`cgevent click: ${r.error}`);
    return;
  }
  const target = x !== undefined && y !== undefined ? `${x},${y}` : ".";
  const op = kind === "left" ? "c" : kind === "right" ? "rc" : kind === "middle" ? "mc" : "dc";
  await cliclick(`${op}:${target}`);
}

export async function drag(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await cliclick(`dd:${from.x},${from.y}`, `dm:${to.x},${to.y}`, `du:${to.x},${to.y}`);
}

/** Low-level CGEvent scroll: dy>0 up, dy<0 down; dx>0 left, dx<0 right. */
export async function cgScroll(opts: {
  dy?: number;
  dx?: number;
  at?: { x: number; y: number };
  unit?: "line" | "pixel";
  steps?: number;
  delayMs?: number;
}): Promise<void> {
  if (!hasCgEvent()) throw new Error(`CGEvent helper not built (expected ${CG_BIN}).`);
  const args = ["scroll", "--dy", String(opts.dy ?? 0), "--dx", String(opts.dx ?? 0)];
  if (opts.at) args.push("--x", String(opts.at.x), "--y", String(opts.at.y));
  if (opts.unit) args.push("--unit", opts.unit);
  if (opts.steps) args.push("--steps", String(opts.steps));
  if (opts.delayMs != null) args.push("--delay-ms", String(opts.delayMs));
  await runCapture(CG_BIN, args, 15_000);
}

/**
 * Scroll the view under (x,y) — or the current pointer. Prefers real CGEvent
 * scroll-wheel events (smooth, both axes, pixel or line units). Falls back to
 * AppleScript System Events / arrow keys when the CGEvent helper is missing.
 */
export async function scroll(
  direction: "up" | "down" | "left" | "right",
  amount: number,
  at?: { x: number; y: number },
  opts: { pixels?: boolean; smooth?: boolean } = {},
): Promise<void> {
  const count = Math.max(1, Math.round(amount));
  if (hasCgEvent()) {
    // Map ticks to a magnitude per axis. Line unit ~ count ticks; pixel unit
    // scales up so a "tick" moves a visible amount.
    const unit = opts.pixels ? "pixel" : "line";
    const mag = opts.pixels ? count * 40 : count;
    const dy = direction === "up" ? mag : direction === "down" ? -mag : 0;
    const dx = direction === "left" ? mag : direction === "right" ? -mag : 0;
    const steps = opts.smooth ? Math.max(count, Math.min(40, mag)) : 1;
    await cgScroll({ dy, dx, at, unit, steps });
    return;
  }
  // Fallback path (no CGEvent binary).
  if (at) await moveCursor(at.x, at.y);
  const dxs = direction === "left" ? -1 : direction === "right" ? 1 : 0;
  const dys = direction === "up" ? 1 : direction === "down" ? -1 : 0;
  for (let i = 0; i < count; i++) {
    await osa(
      `tell application "System Events" to scroll ${dxs === 0 ? (dys > 0 ? "up" : "down") : dxs > 0 ? "right" : "left"} by 1`,
    ).catch(async () => {
      if (dys > 0) await cliclick("kp:arrow-up");
      else if (dys < 0) await cliclick("kp:arrow-down");
      else if (dxs > 0) await cliclick("kp:arrow-right");
      else if (dxs < 0) await cliclick("kp:arrow-left");
    });
  }
}

export function typingTimeoutMs(text: string, delayMs = 0): number {
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error("Typing delay must be a non-negative integer.");
  // Code points conservatively bound Swift grapheme events. Reserve 15 seconds
  // for startup/scheduling and reject oversized input before posting any event.
  const eventTime = Array.from(text).length * (5 + Math.max(5, delayMs));
  if (eventTime > 45_000) throw new Error("Text and delay exceed the 45-second input budget. Split the text into smaller verified calls; no input was sent.");
  return 15_000 + eventTime;
}

export async function typeText(text: string, delayMs = 0): Promise<void> {
  if (!text) return;
  const timeoutMs = typingTimeoutMs(text, delayMs);
  if (hasCgEvent()) {
    const r = JSON.parse(await runCapture(CG_BIN, ["type", "--text", text, "--delay-ms", String(delayMs)],
      timeoutMs));
    if (!r.ok) throw new Error(`cgevent type: ${r.error}`);
    return;
  }
  if (delayMs > 0) {
    for (const ch of text) {
      await osa(`tell application "System Events" to keystroke ${asJSONString(ch)}`);
      await sleep(delayMs);
    }
    return;
  }
  // osascript keystroke handles unicode / accented chars better than cliclick t:
  await osa(`tell application "System Events" to keystroke ${asJSONString(text)}`);
}

/**
 * Send a single named key or a combo like "cmd+c", "cmd+shift+4", "Return".
 */
export async function pressKey(keys: string): Promise<void> {
  const parts = keys.split(/\s*\+\s*/).map((p) => p.trim()).filter(Boolean);
  const modMap: Record<string, string> = {
    cmd: "command down",
    command: "command down",
    meta: "command down",
    ctrl: "control down",
    control: "control down",
    alt: "option down",
    opt: "option down",
    option: "option down",
    shift: "shift down",
    fn: "function down",
  };
  const keyCodeMap: Record<string, number> = {
    return: 36,
    enter: 36,
    tab: 48,
    space: 49,
    delete: 51,
    backspace: 51,
    escape: 53,
    esc: 53,
    "forward-delete": 117,
    home: 115,
    end: 119,
    "page-up": 116,
    pageup: 116,
    "page-down": 121,
    pagedown: 121,
    "arrow-left": 123,
    left: 123,
    "arrow-right": 124,
    right: 124,
    "arrow-down": 125,
    down: 125,
    "arrow-up": 126,
    up: 126,
    f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
    f9: 101, f10: 109, f11: 103, f12: 111,
  };

  const mods: string[] = [];
  let key: string | null = null;
  for (const p of parts) {
    const lc = p.toLowerCase();
    if (modMap[lc]) mods.push(modMap[lc]);
    else key = p;
  }
  if (!key) throw new Error(`No primary key in "${keys}"`);
  const lc = key.toLowerCase();
  const modClause = mods.length ? ` using {${mods.join(", ")}}` : "";
  if (keyCodeMap[lc] !== undefined) {
    await osa(
      `tell application "System Events" to key code ${keyCodeMap[lc]}${modClause}`,
    );
  } else {
    await osa(
      `tell application "System Events" to keystroke ${asJSONString(key)}${modClause}`,
    );
  }
}

export async function focusApp(name: string): Promise<void> {
  await runAx(["focus-app", "--app", name]);
}

export async function appIdentity(app?: string): Promise<{ pid: number; name: string; bundleId: string }> {
  const r = await runAx(["app-info", ...(app ? ["--app", app] : [])]);
  return { pid: r.pid, name: r.name, bundleId: r.bundleId };
}

export async function listRunningApps(): Promise<string[]> {
  const out = await osa(
    `tell application "System Events" to get name of every process whose background only is false`,
  );
  return out.trim().split(/,\s*/).filter(Boolean);
}

export async function frontmostApp(): Promise<string> {
  const out = await osa(
    `tell application "System Events" to get name of first process whose frontmost is true`,
  );
  return out.trim();
}

export async function runApplescript(script: string): Promise<string> {
  return (await osa(script)).trimEnd();
}

function asJSONString(s: string): string {
  return JSON.stringify(s);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function which(bin: string): string | null {
  const r = spawnSync("/usr/bin/which", [bin], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim();
  return null;
}
