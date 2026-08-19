/**
 * Precomputes CLIP text embeddings for the condition catalogue, at build time.
 *
 * This is the whole reason on-device inference is affordable here. MobileCLIP's text encoder is
 * 170 MB at fp32; its vision encoder is 22.9 MB at fp16. The condition labels never change at
 * run time, so the text side runs once, here, and the browser only ever downloads the vision side.
 *
 * The dtype choice is not incidental — see `docs/AUDIT.md` Gate 0. Every int8 quantization of this
 * model is numerically broken: similarity margins collapse to ~0.005 and the ranking becomes
 * noise. Text runs at fp32 (free, it is offline) and vision ships at fp16.
 *
 *   npm run embeddings -w @caliper/web
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';
import { RANKABLE } from '@caliper/core';

export const CLIP_MODEL = 'Xenova/mobileclip_s0';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'src', 'model', 'labelEmbeddings.json');

function l2normalise(v: number[]): number[] {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v;
}

const conditions = RANKABLE.filter((c) => c.labelPrompts.length > 0);
const prompts = conditions.flatMap((c) => c.labelPrompts.map((p) => ({ id: c.id, prompt: p })));

console.log(`Embedding ${prompts.length} prompts across ${conditions.length} conditions…`);

const tokenizer = await AutoTokenizer.from_pretrained(CLIP_MODEL);
const textModel = await CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, { dtype: 'fp32' });

// `padding: 'max_length'` is required: this model's ONNX graph has a fixed 77-token context and
// errors out on a shorter batch. Discovered in Gate 0.
const inputs = tokenizer(prompts.map((p) => p.prompt), { padding: 'max_length', truncation: true });
const { text_embeds } = await textModel(inputs);
const rows: number[][] = text_embeds.tolist();

/** Prompt ensembling: average the normalised embeddings per condition, then renormalise. */
const byCondition = new Map<string, number[]>();
prompts.forEach((p, i) => {
  const v = l2normalise(rows[i]!);
  const acc = byCondition.get(p.id);
  if (!acc) byCondition.set(p.id, [...v]);
  else v.forEach((x, j) => { acc[j]! += x; });
});

const embeddings = Object.fromEntries(
  [...byCondition].map(([id, v]) => [id, l2normalise(v).map((x) => Math.round(x * 1e5) / 1e5)]),
);

const payload = {
  model: CLIP_MODEL,
  dim: rows[0]!.length,
  generatedFrom: `${prompts.length} prompts, fp32 text encoder, prompt-ensembled`,
  embeddings,
};

await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${outPath}  (${Object.keys(embeddings).length} conditions, dim ${payload.dim})`);
