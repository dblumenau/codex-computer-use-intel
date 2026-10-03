import { withoutActivityOverlay } from "./activity.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { geometryFrom, readPngSize, type CaptureGeometry, type Region } from "./geometry.js";
export { readPngSize } from "./geometry.js";
export type { CaptureGeometry, Region } from "./geometry.js";

export interface CaptureOpts {
  region?: Region;
  displayIndex?: number;
  showCursor?: boolean;
  maxWidth?: number;
}

interface DisplayInfo {
  index: number;
  id: number;
  captureIndex: number;
  bounds: Region;
  isMain: boolean;
}

interface DisplaySnapshot {
  mainDisplayId: number;
  displays: DisplayInfo[];
}

const SCREENCAPTURE = "/usr/sbin/screencapture";
const SIPS = "/usr/bin/sips";
const CG_BIN = join(dirname(fileURLToPath(import.meta.url)), "cgevent");

/** Small execFile wrapper used by the capture helper so stderr is preserved. */
function execFileText(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = String(stdout);
        const err = String(stderr);
        if (error) {
          const detail = err.trim() || out.trim() || error.message;
          reject(new Error(`${command} failed: ${detail}`));
          return;
        }
        resolve(out);
      },
    );
  });
}

function helperMissingError(): Error {
  return new Error(`CGEvent helper not built (expected ${CG_BIN}). Run: npm run build:cg`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`cgevent displays returned invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function numberField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`cgevent displays returned invalid ${label}`);
  }
  return value;
}

function integerField(value: unknown, label: string): number {
  const n = numberField(value, label);
  if (!Number.isInteger(n)) throw new Error(`cgevent displays returned non-integer ${label}`);
  return n;
}

function parseDisplays(output: string): DisplaySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`Could not parse cgevent displays output: ${output.trim()}`);
  }
  const root = record(parsed, "JSON");
  if (root.ok === false) {
    throw new Error(`cgevent displays: ${String(root.error ?? "unknown error")}`);
  }
  if (!Array.isArray(root.displays) || root.displays.length === 0) {
    throw new Error("No active displays are available. Wake and unlock the Mac, then capture again; this alone does not establish a missing Screen Recording permission.");
  }
  const displays: DisplayInfo[] = root.displays.map((item, i) => {
    const d = record(item, `display ${i}`);
    const b = record(d.bounds, `display ${i} bounds`);
    const index = integerField(d.index ?? i, `display ${i} index`);
    const id = integerField(d.id ?? d.displayID, `display ${i} id`);
    const captureIndex = integerField(d.captureIndex ?? index + 1, `display ${i} captureIndex`);
    const bounds: Region = {
      x: numberField(b.x, `display ${i} bounds.x`),
      y: numberField(b.y, `display ${i} bounds.y`),
      width: numberField(b.width, `display ${i} bounds.width`),
      height: numberField(b.height, `display ${i} bounds.height`),
    };
    if (bounds.width <= 0 || bounds.height <= 0) {
      throw new Error(`cgevent displays returned non-positive bounds for display ${i}`);
    }
    if (captureIndex <= 0) throw new Error(`cgevent displays returned invalid captureIndex for display ${i}`);
    return {
      index,
      id,
      captureIndex,
      bounds,
      isMain: d.isMain === true,
    };
  });
  const mainDisplayId = integerField(root.mainDisplayID ?? root.mainDisplayId, "mainDisplayID");
  if (!displays.some((d) => d.id === mainDisplayId)) {
    throw new Error(`cgevent displays mainDisplayID ${mainDisplayId} is not active`);
  }
  return { mainDisplayId, displays };
}

async function readDisplaySnapshot(): Promise<DisplaySnapshot> {
  if (!await fileExists(CG_BIN)) throw helperMissingError();
  const output = await execFileText(CG_BIN, ["displays"], 10_000);
  return parseDisplays(output);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function validateRegion(region: Region): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    const value = region[key];
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`region.${key} must be a finite integer`);
    }
  }
  if (region.width <= 0 || region.height <= 0) {
    throw new Error("region width and height must be positive");
  }
}

function validateOpts(opts: CaptureOpts): void {
  if (opts.region) validateRegion(opts.region);
  if (opts.displayIndex !== undefined &&
      (!Number.isInteger(opts.displayIndex) || opts.displayIndex < 0)) {
    throw new Error("displayIndex must be a non-negative integer");
  }
  if (opts.region && opts.displayIndex !== undefined) {
    throw new Error("region and displayIndex cannot be combined; choose a region or a display");
  }
  if (opts.maxWidth !== undefined &&
      (!Number.isInteger(opts.maxWidth) || opts.maxWidth <= 0)) {
    throw new Error("maxWidth must be a positive integer");
  }
}

function contains(outer: Region, inner: Region): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function targetDisplay(snapshot: DisplaySnapshot, opts: CaptureOpts): DisplayInfo {
  if (opts.displayIndex !== undefined) {
    const target = snapshot.displays.find((d) => d.index === opts.displayIndex) ?? snapshot.displays[opts.displayIndex];
    if (!target) throw new Error(`displayIndex ${opts.displayIndex} is not an active display`);
    return target;
  }
  const target = snapshot.displays.find((d) => d.id === snapshot.mainDisplayId);
  if (!target) throw new Error("main display is not present in active display list");
  return target;
}

function boundsFor(snapshot: DisplaySnapshot, opts: CaptureOpts): Region {
  if (opts.region) {
    const owner = snapshot.displays.find((d) => contains(d.bounds, opts.region!));
    if (!owner) {
      throw new Error(
        `region ${opts.region.x},${opts.region.y},${opts.region.width},${opts.region.height} ` +
          "must be fully inside one active display",
      );
    }
    return { ...opts.region };
  }
  return { ...targetDisplay(snapshot, opts).bounds };
}

/** Resolve the exact screen-point rectangle that will be captured. */
export async function resolveCaptureBounds(opts: CaptureOpts = {}): Promise<Region> {
  validateOpts(opts);
  const snapshot = await readDisplaySnapshot();
  return boundsFor(snapshot, opts);
}

function sameRegion(a: Region, b: Region): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameDisplays(a: DisplaySnapshot, b: DisplaySnapshot): boolean {
  if (a.mainDisplayId !== b.mainDisplayId || a.displays.length !== b.displays.length) return false;
  return a.displays.every((left, i) => {
    const right = b.displays[i];
    return (
      right !== undefined &&
      left.index === right.index &&
      left.id === right.id &&
      left.captureIndex === right.captureIndex &&
      left.isMain === right.isMain &&
      sameRegion(left.bounds, right.bounds)
    );
  });
}

function displayLayoutSignature(snapshot: DisplaySnapshot): string {
  return JSON.stringify({
    mainDisplayID: snapshot.mainDisplayId,
    displays: snapshot.displays.map((display) => ({
      index: display.index,
      id: display.id,
      captureIndex: display.captureIndex,
      isMain: display.isMain,
      bounds: display.bounds,
    })),
  });
}

/** Return the current active-display layout in the same format captures record. */
export async function currentDisplayLayout(): Promise<string> {
  return displayLayoutSignature(await readDisplaySnapshot());
}

function captureArgs(opts: CaptureOpts, bounds: Region, display: DisplayInfo | undefined, path: string): string[] {
  const args = ["-x", "-t", "png"];
  if (opts.showCursor) args.push("-C");
  if (opts.region) {
    args.push("-R", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`);
  } else {
    if (!display) throw new Error("capture target display is missing");
    // -D is deliberately used even for the main display so screencapture can
    // never create a multi-display TIFF/PNG when no region was requested.
    args.push("-D", String(display.captureIndex));
  }
  args.push(path);
  return args;
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // The capture may have failed before creating its output.
  }
}

/**
 * Capture one display/region and return the actual PNG dimensions plus its
 * point-to-pixel geometry. The caller owns a successful `path` and must remove
 * it when finished; all failed captures are cleaned up here.
 */
export async function captureImageToFile(
  opts: CaptureOpts = {},
): Promise<{ path: string; geometry: CaptureGeometry }> {
  validateOpts(opts);
  const before = await readDisplaySnapshot();
  const bounds = boundsFor(before, opts);
  const display = opts.region ? undefined : targetDisplay(before, opts);
  const displayLayout = displayLayoutSignature(before);
  const path = join(tmpdir(), `cui-capture-${randomUUID()}.png`);
  let success = false;
  try {
    await withoutActivityOverlay(() => execFileText(SCREENCAPTURE, captureArgs(opts, bounds, display, path), 20_000));
    const capturedAt = new Date().toISOString();
    const after = await readDisplaySnapshot();
    if (!sameDisplays(before, after)) {
      throw new Error("display geometry changed during capture; screenshot discarded");
    }

    let size = readPngSize(await readFile(path));
    if (opts.maxWidth !== undefined && size.width > opts.maxWidth) {
      await execFileText(SIPS, ["--resampleWidth", String(opts.maxWidth), path], 20_000);
      size = readPngSize(await readFile(path));
      if (size.width > opts.maxWidth) {
        throw new Error(`sips did not downscale PNG to maxWidth ${opts.maxWidth}`);
      }
    }
    success = true;
    return {
      path,
      geometry: { ...geometryFrom(bounds, size, capturedAt), displayLayout },
    };
  } finally {
    if (!success) await removeIfPresent(path);
  }
}
