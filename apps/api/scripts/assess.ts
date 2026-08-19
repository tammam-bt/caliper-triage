/**
 * Runs the full assessment pipeline over a local image and prints the result.
 *
 *   npx tsx scripts/assess.ts <image> ["symptom text"]
 *
 * The same core the API and the browser use, with no server and no UI in the way. Useful for
 * checking what the measurements actually are on a given photograph, which is a different
 * question from whether the app renders.
 */
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { extractFeatures, featuresToCues, fuse, IntakeSchema } from '@caliper/core';

const path = process.argv[2];
if (!path) {
  console.error('usage: npx tsx scripts/assess.ts <image> ["symptom text"]');
  process.exit(1);
}
const symptomsText = process.argv[3] ?? '';

const { data, info } = await sharp(await readFile(path))
  .rotate()
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const { features, quality } = extractFeatures({
  data: new Uint8ClampedArray(data),
  width: info.width,
  height: info.height,
});

const out = fuse({ intake: IntakeSchema.parse({ symptomsText }), quality, features });

console.log(`\n${path}  ${info.width}x${info.height}`);
console.log(`quality      : ${quality.usable ? 'usable' : quality.issues.map((i) => i.code).join(', ')}`);
console.log(
  `features     : A=${features.asymmetry.toFixed(3)} B=${features.borderIrregularity.toFixed(2)} ` +
    `C=${features.colourHeterogeneity.toFixed(2)} entropy=${features.textureEntropy.toFixed(2)} ` +
    `speckle=${features.brightSpeckleRatio.toFixed(3)} area=${(features.maskAreaRatio * 100).toFixed(1)}% ` +
    `rgb=${features.meanColour.map((c) => Math.round(c)).join(',')}`,
);

const cues = featuresToCues(features);
console.log(
  `cues         : ${Object.entries(cues).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ')}`,
);
console.log(
  `verdict      : ${out.abstained ? 'ABSTAINED' : out.candidates[0]!.displayName} ` +
    `conf=${(out.confidence * 100).toFixed(0)}% acuity=${out.acuity}` +
    `${out.abstainReason ? `  (${out.abstainReason})` : ''}`,
);
for (const c of out.candidates.slice(0, 4)) {
  console.log(`   ${c.displayName.padEnd(26)} ${(c.probability * 100).toFixed(1).padStart(5)}%  ${c.acuity}`);
}
