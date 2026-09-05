/** A rectangle in global macOS screen coordinates (points, top-left origin). */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImagePixels {
  width: number;
  height: number;
}

export interface ImageToScreen {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

export interface CaptureGeometry {
  screenBoundsPoints: Region;
  imagePixels: ImagePixels;
  imageToScreen: ImageToScreen;
  capturedAt: string;
  /** Signature of the active display layout at capture time, when available. */
  displayLayout?: string;
}

/** Read width and height from a PNG's IHDR chunk without image decoding. */
export function readPngSize(buffer: Uint8Array): { width: number; height: number } {
  if (buffer.byteLength < 24) throw new Error("Invalid PNG: file is too short");
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) throw new Error("Invalid PNG: bad signature");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(8) !== 13 ||
      buffer[12] !== 0x49 || buffer[13] !== 0x48 || buffer[14] !== 0x44 || buffer[15] !== 0x52) {
    throw new Error("Invalid PNG: missing IHDR chunk");
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0) throw new Error("Invalid PNG: empty image dimensions");
  return { width, height };
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function validateBounds(bounds: Region): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    assertFiniteNumber(bounds[key], `bounds.${key}`);
  }
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("bounds width and height must be positive");
  }
}

function validateImageSize(size: ImagePixels): void {
  for (const key of ["width", "height"] as const) {
    assertFiniteNumber(size[key], `image size ${key}`);
    if (!Number.isInteger(size[key]) || size[key] <= 0) {
      throw new Error(`image size ${key} must be a positive integer`);
    }
  }
}

/**
 * Build the point-to-pixel transform for a capture. The image is assumed to
 * cover the complete screen rectangle represented by `bounds`; this remains
 * true after a Retina capture or an optional pixel downscale.
 */
export function geometryFrom(
  bounds: Region,
  size: ImagePixels,
  capturedAt = new Date().toISOString(),
): CaptureGeometry {
  validateBounds(bounds);
  validateImageSize(size);
  if (typeof capturedAt !== "string" || !capturedAt) {
    throw new Error("capturedAt must be a non-empty ISO timestamp string");
  }
  return {
    screenBoundsPoints: { ...bounds },
    imagePixels: { ...size },
    imageToScreen: {
      scaleX: bounds.width / size.width,
      scaleY: bounds.height / size.height,
      offsetX: bounds.x,
      offsetY: bounds.y,
    },
    capturedAt,
  };
}

/**
 * Convert an image pixel coordinate to an integer global screen point.
 * Coordinates outside the half-open image rectangle are rejected. The
 * resulting integer is bounded to the last integer point in the captured
 * screen rectangle, which protects Retina/downscale rounding at the edge.
 */
export function imagePointToScreen(
  geometry: CaptureGeometry,
  x: number,
  y: number,
): { x: number; y: number } {
  if (!geometry || typeof geometry !== "object") throw new Error("geometry is required");
  validateBounds(geometry.screenBoundsPoints);
  validateImageSize(geometry.imagePixels);
  for (const key of ["scaleX", "scaleY", "offsetX", "offsetY"] as const) {
    assertFiniteNumber(geometry.imageToScreen[key], `imageToScreen.${key}`);
  }
  if (geometry.imageToScreen.scaleX <= 0 || geometry.imageToScreen.scaleY <= 0) {
    throw new Error("imageToScreen scales must be positive");
  }
  assertFiniteNumber(x, "image x");
  assertFiniteNumber(y, "image y");
  const { width, height } = geometry.imagePixels;
  if (x < 0 || x >= width || y < 0 || y >= height) {
    throw new RangeError(`image point (${x},${y}) is outside ${width}x${height}`);
  }

  const bounds = geometry.screenBoundsPoints;
  const sx = Math.round(geometry.imageToScreen.offsetX + x * geometry.imageToScreen.scaleX);
  const sy = Math.round(geometry.imageToScreen.offsetY + y * geometry.imageToScreen.scaleY);
  const maxX = Math.ceil(bounds.x + bounds.width) - 1;
  const maxY = Math.ceil(bounds.y + bounds.height) - 1;
  const within = (value: number, min: number, max: number): number => {
    const bounded = Math.min(Math.max(value, min), max);
    return Object.is(bounded, -0) ? 0 : bounded;
  };
  return {
    x: within(sx, Math.ceil(bounds.x), maxX),
    y: within(sy, Math.ceil(bounds.y), maxY),
  };
}
