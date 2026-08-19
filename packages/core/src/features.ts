/**
 * Feature extraction: RGBA pixels in, a named descriptor vector out.
 *
 * Everything here is deterministic and side-effect free, which is what lets the same function run
 * in a Vercel-less browser demo, in an Express worker, and in a unit test with a synthetic fixture.
 */
import type { ImageFeatures, QualityIssue, QualityReport } from './schemas.js';
import type { Lab, RgbaImage } from './image/index.js';
import {
  asymmetryIndex,
  computeMoments,
  contourPerimeter,
  downsample,
  kmeansLab,
  luminanceEntropy,
  brightSpeckleRatio,
  rgbToLab,
  segment,
  toGrayscale,
  traceContour,
  assessQuality,
} from './image/index.js';

/**
 * Work at 512px on the long edge. Shape and colour statistics are scale-invariant, and this keeps
 * a 12-megapixel phone photo from costing two seconds of main-thread time in the browser.
 */
export const WORKING_MAX_SIDE = 512;

/** Cap on pixels fed to k-means; the estimate is stable well below this. */
const MAX_CLUSTER_SAMPLES = 4000;

export interface ExtractOptions {
  /** Supplied when a scale reference is present, enabling millimetre output. */
  pixelsPerMm?: number;
}

export interface Extraction {
  features: ImageFeatures;
  /** The downsampled frame the features were measured on — the viewport draws the contour on this. */
  working: RgbaImage;
  /**
   * Acquisition quality *including* segmentation-derived issues. This is the authoritative report;
   * callers should not run `assessQuality` separately, or they will miss `no_subject`.
   */
  quality: QualityReport;
}

export function extractFeatures(source: RgbaImage, options: ExtractOptions = {}): Extraction {
  const working = downsample(source, WORKING_MAX_SIDE);
  const scale = working.width / source.width;

  const quality = assessQuality(working);
  const issues: QualityIssue[] = [...quality.report.issues];
  const mask = segment(working);

  if (mask.area === 0) {
    issues.push({
      code: 'no_subject',
      measured: 0,
      threshold: 1,
      message:
        'No distinct area could be separated from the surrounding skin. Include a margin of normal skin around the area, and avoid filling the whole frame.',
    });
  }
  const moments = computeMoments(mask);
  const contour = traceContour(mask);
  const perimeter = contourPerimeter(contour);
  const gray = toGrayscale(working);

  // --- intra-lesion colour and luminance samples ---
  const labSamples: Lab[] = [];
  const lumaSamples: number[] = [];
  let rSum = 0, gSum = 0, bSum = 0;
  const stride = Math.max(1, Math.floor(mask.area / MAX_CLUSTER_SAMPLES));
  let seen = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] !== 1) continue;
    const o = i * 4;
    const r = working.data[o]!, g = working.data[o + 1]!, b = working.data[o + 2]!;
    rSum += r; gSum += g; bSum += b;
    lumaSamples.push(gray[i]!);
    if (seen % stride === 0) labSamples.push(rgbToLab(r, g, b));
    seen++;
  }

  const area = Math.max(1, mask.area);
  const meanColour: [number, number, number] = [rSum / area, gSum / area, bSum / area];

  // Reciprocal circularity. A perfect disc is 1.0; a ragged outline climbs above it.
  // Guarded because a degenerate mask yields a zero perimeter.
  const circularity = perimeter > 0 ? (4 * Math.PI * mask.area) / (perimeter * perimeter) : 1;
  const borderIrregularity = circularity > 0 ? clamp(1 / circularity, 0, 8) : 1;

  const cluster = kmeansLab(labSamples, 6);

  // Report the diameter in the *source* image's pixels, not the working copy's.
  const diameterPx = moments.majorAxis / (scale || 1);
  const pixelsPerMm = options.pixelsPerMm;

  const features: ImageFeatures = {
    asymmetry: round(asymmetryIndex(mask, moments), 4),
    borderIrregularity: round(borderIrregularity, 4),
    colourHeterogeneity: round(cluster.effectiveCount, 4),
    diameterPx: round(diameterPx, 2),
    ...(pixelsPerMm ? { diameterMm: round(diameterPx / pixelsPerMm, 2) } : {}),
    textureEntropy: round(luminanceEntropy(lumaSamples), 4),
    blurScore: round(quality.blurScore, 2),
    exposureScore: round(quality.exposure, 4),
    maskAreaRatio: round(mask.area / (working.width * working.height), 4),
    brightSpeckleRatio: round(brightSpeckleRatio(lumaSamples), 4),
    contour: simplifyContour(contour, scale),
    meanColour: [round(meanColour[0], 1), round(meanColour[1], 1), round(meanColour[2], 1)],
  };

  return { features, working, quality: { usable: issues.length === 0, issues } };
}

/**
 * Contours come out one point per boundary pixel — several thousand for a large lesion, all of
 * which would be serialised into every API response. Keep every Nth point, capped at 240, which
 * is well past the resolution at which the drawn outline stops improving.
 */
function simplifyContour(contour: Array<[number, number]>, scale: number): Array<[number, number]> {
  const MAX_POINTS = 240;
  if (contour.length === 0) return [];
  const step = Math.max(1, Math.ceil(contour.length / MAX_POINTS));
  const out: Array<[number, number]> = [];
  for (let i = 0; i < contour.length; i += step) {
    const p = contour[i]!;
    out.push([round(p[0] / scale, 1), round(p[1] / scale, 1)]);
  }
  return out;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export { assessQuality };
export type { RgbaImage };
