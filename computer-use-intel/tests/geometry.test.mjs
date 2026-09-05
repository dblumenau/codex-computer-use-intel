import assert from "node:assert/strict";
import test from "node:test";

import { readPngSize } from "../dist/geometry.js";
import { geometryFrom, imagePointToScreen } from "../dist/geometry.js";

test("maps a 2560x1440 capture downscaled to 1280x720", () => {
  const geometry = geometryFrom(
    { x: 0, y: 0, width: 2560, height: 1440 },
    { width: 1280, height: 720 },
    "2026-09-05T00:00:00.000Z",
  );
  assert.deepEqual(geometry.imageToScreen, { scaleX: 2, scaleY: 2, offsetX: 0, offsetY: 0 });
  assert.deepEqual(imagePointToScreen(geometry, 1279, 719), { x: 2558, y: 1438 });
});

test("maps Retina pixels and keeps the final point inside the rect", () => {
  const geometry = geometryFrom(
    { x: 0, y: 0, width: 1440, height: 900 },
    { width: 2880, height: 1800 },
  );
  assert.deepEqual(geometry.imageToScreen, { scaleX: 0.5, scaleY: 0.5, offsetX: 0, offsetY: 0 });
  assert.deepEqual(imagePointToScreen(geometry, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(imagePointToScreen(geometry, 2879, 1799), { x: 1439, y: 899 });
});

test("preserves a region with negative global origins", () => {
  const geometry = geometryFrom(
    { x: -1280, y: -100, width: 640, height: 400 },
    { width: 320, height: 200 },
  );
  assert.deepEqual(imagePointToScreen(geometry, 0, 0), { x: -1280, y: -100 });
  assert.deepEqual(imagePointToScreen(geometry, 319, 199), { x: -642, y: 298 });
});

test("rejects image points outside the half-open image rectangle", () => {
  const geometry = geometryFrom({ x: 10, y: 20, width: 30, height: 40 }, { width: 10, height: 20 });
  assert.throws(() => imagePointToScreen(geometry, -1, 0), RangeError);
  assert.throws(() => imagePointToScreen(geometry, 10, 0), RangeError);
  assert.throws(() => imagePointToScreen(geometry, 0, 20), RangeError);
  assert.throws(() => imagePointToScreen(geometry, Number.NaN, 0), /finite/);
});

test("rounds screen points but never crosses the inclusive integer edge", () => {
  const geometry = geometryFrom({ x: 10, y: -4, width: 3, height: 3 }, { width: 2, height: 2 });
  assert.deepEqual(imagePointToScreen(geometry, 1, 1), { x: 12, y: -2 });
  assert.deepEqual(imagePointToScreen(geometry, 1.999, 1.999), { x: 12, y: -2 });
});

test("reads PNG dimensions from IHDR and rejects malformed data", () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  Buffer.from("IHDR", "ascii").copy(png, 12);
  png.writeUInt32BE(2560, 16);
  png.writeUInt32BE(1440, 20);
  assert.deepEqual(readPngSize(png), { width: 2560, height: 1440 });
  assert.throws(() => readPngSize(Buffer.alloc(24)), /Invalid PNG/);
  const badChunk = Buffer.from(png);
  badChunk.writeUInt32BE(12, 8);
  assert.throws(() => readPngSize(badChunk), /IHDR/);
});
