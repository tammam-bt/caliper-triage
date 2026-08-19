/**
 * Pixel-buffer primitives. Isomorphic: the input is always plain RGBA bytes, so the browser can
 * hand us `ImageData.data` and Node can hand us a decoded buffer, and neither layer leaks in here.
 */

/** Row-major RGBA, 4 bytes per pixel — the layout of both `ImageData` and `sharp`'s raw output. */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function assertRgba(img: RgbaImage): void {
  const expected = img.width * img.height * 4;
  if (img.width <= 0 || img.height <= 0) {
    throw new Error(`Invalid image dimensions ${img.width}x${img.height}`);
  }
  if (img.data.length !== expected) {
    throw new Error(`RGBA buffer length ${img.data.length} does not match ${img.width}x${img.height} (expected ${expected})`);
  }
}

/** Rec.709 relative luminance, 0..255. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function toGrayscale(img: RgbaImage): Float32Array {
  assertRgba(img);
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = luma(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!);
  }
  return out;
}

/**
 * Box-filter downsample to fit within `maxSide`. Everything downstream runs on this rather than a
 * 12-megapixel phone photo: the features we compute are shape and colour statistics that are scale
 * invariant, and the cost difference is two orders of magnitude.
 */
export function downsample(img: RgbaImage, maxSide: number): RgbaImage {
  assertRgba(img);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale >= 1) return img;

  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const xRatio = img.width / w;
  const yRatio = img.height / h;

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * img.width + sx) * 4;
          r += img.data[o]!; g += img.data[o + 1]!; b += img.data[o + 2]!; a += img.data[o + 3]!;
          count++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / count; out[o + 1] = g / count; out[o + 2] = b / count; out[o + 3] = a / count;
    }
  }
  return { data: out, width: w, height: h };
}

// --- CIE Lab -------------------------------------------------------------------
// Colour distance in RGB is perceptually meaningless: #FF0000 and #FF3300 are far apart
// numerically and near-identical to an eye. Clustering lesion colour needs a perceptually
// uniform space, so we convert to Lab (D65) before k-means.

export type Lab = [number, number, number];

function pivotRgb(c: number): number {
  const v = c / 255;
  return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
}

function pivotXyz(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const rl = pivotRgb(r), gl = pivotRgb(g), bl = pivotRgb(b);
  // sRGB -> XYZ, D65 reference white
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const fx = pivotXyz(x), fy = pivotXyz(y), fz = pivotXyz(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labDistance(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
