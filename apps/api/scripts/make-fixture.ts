/**
 * Writes a synthetic lesion PNG to disk, for exercising the API by hand.
 *
 * Usage: npx tsx scripts/make-fixture.ts [disc|lobed|crescent|twoTone|erythema] [outPath]
 *
 * Real clinical photographs are not something to commit to a public repository, and a reviewer
 * should not have to find one before they can try the endpoint. These fixtures are the same ones
 * the test suite asserts against, so their expected measurements are already documented.
 */
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { crescent, disc, erythematousPatch, lobedBlob, twoToneDisc } from '@caliper/core/testing';

const BUILDERS = {
  disc: () => disc(70),
  lobed: () => lobedBlob(70),
  crescent: () => crescent(70),
  twoTone: () => twoToneDisc(70),
  erythema: () => erythematousPatch(60),
} as const;

const name = (process.argv[2] ?? 'lobed') as keyof typeof BUILDERS;
const out = process.argv[3] ?? `/tmp/caliper-${name}.png`;

const build = BUILDERS[name];
if (!build) {
  console.error(`Unknown fixture "${name}". Choose one of: ${Object.keys(BUILDERS).join(', ')}`);
  process.exit(1);
}

const image = build();
const png = await sharp(Buffer.from(image.data), {
  raw: { width: image.width, height: image.height, channels: 4 },
}).png().toBuffer();

await writeFile(out, png);
console.log(`${out}  ${png.length} bytes  ${image.width}x${image.height}`);
