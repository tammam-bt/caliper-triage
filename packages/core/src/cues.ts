/**
 * Features -> cue activations.
 *
 * Raw features are in incomparable units: an entropy in bits, a ratio, a pixel count. Conditions
 * are scored as a weighted sum, so each feature is first mapped through a documented response
 * curve into a common 0..1 activation. Keeping this mapping in one small file means the answer to
 * "why did it say that?" is always two lookups away: this table, then the catalogue's weights.
 *
 * The breakpoints are chosen to put ordinary lesions near the middle of each range. They are
 * illustrative, not fitted — see the header of `catalogue.ts`.
 */
import type { CueId } from './catalogue.js';
import type { ImageFeatures } from './schemas.js';

/** Linear ramp from `lo` (0) to `hi` (1), clamped at both ends. */
export function ramp(value: number, lo: number, hi: number): number {
  if (hi === lo) return value >= hi ? 1 : 0;
  return Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
}

/**
 * Border irregularity of a digitised perfect disc: 1.019 noisy, 0.978 clean, 0.985 small, measured
 * on `testing/fixtures.ts` and asserted by `features.test.ts`. Getting this to the theoretical 1.0
 * took Kulpa's chain-code factor plus a majority filter on the mask.
 *
 * It is kept as a documented reference point, but it is deliberately *not* the ramp floor. See
 * `PHOTOGRAPH_RANGES`.
 */
export const BORDER_IRREGULARITY_DISC_BASELINE = 1.05;

/**
 * Ramp endpoints, calibrated on photographs rather than on fixtures.
 *
 * This distinction was an outright bug for a while. The ramps were originally anchored to the
 * synthetic fixtures — a disc measures border irregularity 1.0 and asymmetry 0.006 — so the ramps
 * spanned roughly 1.05 to 3.0 and 0.03 to 0.30. Real clinical photographs do not live anywhere
 * near there: measured across the four bundled samples, border irregularity runs 3.8 to 6.5 and
 * asymmetry 0.14 to 0.40, because a real lesion boundary is genuinely ragged and no amount of mask
 * smoothing changes that (swept to 12 passes; it converges around 3.3 to 6.1).
 *
 * The consequence was that both cues sat pinned at 1.0 activation for *every* photograph. Melanoma
 * weights those two most heavily, so melanoma led the differential on every real image regardless
 * of content — a system that looked like it was reading the picture and was not.
 *
 * These endpoints span the observed photographic range instead. They are calibrated on four
 * images, which is few enough that it is a stopgap rather than a fit: the production answer is a
 * model trained on a labelled dataset, at which point this table is deleted rather than retuned.
 */
export const PHOTOGRAPH_RANGES = {
  asymmetry: [0.12, 0.42],
  borderIrregularity: [3.2, 7],
  colourVariegation: [1.2, 5.6],
  textureRoughness: [2.6, 4.6],
  /** Mask area as a fraction of the frame. Real captures fill far more of the frame than fixtures. */
  diameter: [0.02, 0.55],
  /** Δa* — how much redder the lesion is than this person's own surrounding skin. */
  erythema: [2, 16],
  /** ΔL* — how much *darker* the lesion is than the surrounding skin. */
  pigmentation: [4, 32],
  /** ΔL* in the other direction: how much lighter, for the pearly translucency of a BCC. */
  pearlySheen: [3, 20],
} as const;

export type CueActivations = Record<CueId, number>;

export function featuresToCues(f: ImageFeatures): CueActivations {
  const [r, g, b] = f.meanColour;
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;

  /*
   * Colour cues are differences from this person's own unaffected skin, not absolute values.
   *
   * The version this replaces measured redness as `(R - (G+B)/2)`, which cannot tell inflammation
   * from brown pigment — a melanoma scored a *higher* erythema activation than a cellulitis,
   * because brown is dark orange in RGB. The obvious patch, gating erythema on absolute lightness,
   * is worse than the bug: it defines one skin tone as the baseline and would systematically
   * under-detect erythema on darker skin, which is a well-documented failure mode of dermatology
   * imaging tools.
   *
   * Δa* and ΔL* against the segmented reference are tone-invariant and are also what the clinical
   * question actually is: is this redder, or darker, than the skin around it.
   */
  const deltaA = f.lesionLab[1] - f.referenceLab[1];
  const deltaL = f.lesionLab[0] - f.referenceLab[0];

  return {
    asymmetry: ramp(f.asymmetry, ...PHOTOGRAPH_RANGES.asymmetry),
    borderIrregularity: ramp(f.borderIrregularity, ...PHOTOGRAPH_RANGES.borderIrregularity),
    // Perplexity of the perceptually-merged Lab clusters: 1 = one colour, 6 = six distinct ones.
    colourVariegation: ramp(f.colourHeterogeneity, ...PHOTOGRAPH_RANGES.colourVariegation),
    // Relative to the frame, since absolute pixels depend on how close the camera was.
    diameter: ramp(f.maskAreaRatio, ...PHOTOGRAPH_RANGES.diameter),
    textureRoughness: ramp(f.textureEntropy, ...PHOTOGRAPH_RANGES.textureRoughness),
    erythema: ramp(deltaA, ...PHOTOGRAPH_RANGES.erythema),
    // Darker than the surrounding skin, and saturated: pigment rather than shadow.
    pigmentation: ramp(-deltaL, ...PHOTOGRAPH_RANGES.pigmentation) * ramp(saturation, 0.1, 0.5),
    // Lighter than the surrounding skin, desaturated and glossy — a BCC's pearly translucency.
    pearlySheen:
      ramp(deltaL, ...PHOTOGRAPH_RANGES.pearlySheen) *
      ramp(1 - saturation, 0.55, 0.85) *
      ramp(f.brightSpeckleRatio, 0.02, 0.14),
    scaling: ramp(f.brightSpeckleRatio, 0.04, 0.2),
  };
}
