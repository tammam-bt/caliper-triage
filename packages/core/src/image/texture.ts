/**
 * Surface-texture measures taken inside the lesion mask.
 *
 * These separate the conditions that shape and colour cannot. A seborrhoeic keratosis and a
 * benign naevus can present with similar outlines and similar browns; what differs is that one
 * has a rough, keratotic surface and the other is smooth. Psoriasis is defined by its scale.
 */

/**
 * Shannon entropy of a 32-bin luminance histogram, in bits. A flat, evenly-lit surface
 * concentrates in a few bins (low entropy); a keratotic or ulcerated one spreads out.
 */
export function luminanceEntropy(values: number[]): number {
  if (values.length === 0) return 0;
  const bins = 32;
  const hist = new Float64Array(bins);
  for (const v of values) {
    hist[Math.min(bins - 1, Math.max(0, Math.floor((v / 256) * bins)))]! += 1;
  }
  let h = 0;
  for (let i = 0; i < bins; i++) {
    const p = hist[i]! / values.length;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Fraction of intra-lesion pixels significantly brighter than the local mean.
 * Silvery psoriatic scale and keratotic crust both read as bright speckle against the plaque.
 */
export function brightSpeckleRatio(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let varSum = 0;
  for (const v of values) varSum += (v - mean) ** 2;
  const sd = Math.sqrt(varSum / values.length);
  if (sd < 1e-6) return 0;
  const cut = mean + 1.2 * sd;
  let n = 0;
  for (const v of values) if (v > cut) n++;
  return n / values.length;
}
