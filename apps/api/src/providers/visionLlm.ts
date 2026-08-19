/**
 * Multimodal LLM inference over an OpenAI-compatible chat-completions endpoint.
 *
 * Verified against OpenRouter's free vision models — see `docs/AUDIT.md` Gate 0.4. Three things
 * that verification taught, each of which is handled here rather than assumed away:
 *
 * 1. Free models are rate-limited unpredictably. `gemma-4-31b:free` returned 429 on the first
 *    attempt while two others succeeded, so the model id is a *list* and we walk it.
 * 2. Both models wrapped their JSON in ```json fences despite being told to return only JSON.
 *    Fences are stripped before parsing.
 * 3. The output is free-text from a general model, so it is schema-validated and its condition
 *    names are mapped onto the catalogue. Anything unrecognised is dropped, not guessed at.
 *
 * On any failure the caller falls back to `CvHeuristicProvider`. A remote model being unavailable
 * must degrade the answer, not remove it.
 */
import { z } from 'zod';
import { CONDITION_IDS, type ConditionId, type Intake, type MediaRef, type RgbaImage } from '@caliper/core';
import { CONDITIONS } from '@caliper/core';
import type { InferenceProvider, ProviderOutput } from '@caliper/service';
import { CvHeuristicProvider } from '@caliper/service';
import sharp from 'sharp';

const ResponseSchema = z.object({
  candidates: z.array(z.object({
    condition: z.string(),
    probability: z.number().min(0).max(1),
    rationale: z.string().optional(),
  })).max(8),
  quality: z.object({ usable: z.boolean(), note: z.string().optional() }).optional(),
});

const SYSTEM_PROMPT = [
  'You are an assistive triage aid for a clinician. You are not a diagnostician and your output',
  'is never shown to a patient as a diagnosis.',
  'Rank up to four dermatological candidates for the supplied image.',
  `Use ONLY these condition identifiers: ${CONDITION_IDS.filter((c) => c !== 'insufficient_evidence').join(', ')}.`,
  'Return ONLY a JSON object, no prose and no code fences, matching exactly:',
  '{"candidates":[{"condition":"<id>","probability":<0..1>,"rationale":"<short>"}],',
  ' "quality":{"usable":<bool>,"note":"<short>"}}',
  'If the image is too poor to assess, set quality.usable to false and return an empty candidates array.',
].join(' ');

export interface VisionLlmOptions {
  apiKey: string;
  baseUrl: string;
  models: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class VisionLlmProvider implements InferenceProvider {
  readonly id = 'vision-llm';
  readonly modelId: string;
  private readonly fallback = new CvHeuristicProvider();

  constructor(private readonly options: VisionLlmOptions) {
    this.modelId = options.models[0] ?? 'unknown';
  }

  async infer(input: { frames: RgbaImage[]; intake: Intake; media: MediaRef }): Promise<ProviderOutput> {
    // The heuristic pass always runs: it supplies the measured features and the quality gate, which
    // the LLM cannot provide and which the readout displays regardless of which model ranked.
    const base = await this.fallback.infer(input);
    const frame = input.frames[0];
    if (!frame) return base;

    try {
      const dataUrl = await toJpegDataUrl(frame);
      const posterior = await this.rank(dataUrl, input.intake);
      if (!posterior) return base;
      return { ...base, modelPosterior: posterior.posterior, modelLabel: `${posterior.model} (vision LLM)` };
    } catch {
      // Deliberately swallowed: a rate limit or a timeout downgrades to measured features rather
      // than failing the analysis. The result records which provider actually produced it.
      return base;
    }
  }

  private async rank(
    dataUrl: string,
    intake: Intake,
  ): Promise<{ posterior: Partial<Record<ConditionId, number>>; model: string } | null> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const userText = intake.symptomsText
      ? `Reported symptoms: ${intake.symptomsText.slice(0, 500)}`
      : 'No symptoms were reported.';

    for (const model of this.options.models) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20000);
      try {
        const response = await doFetch(`${this.options.baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: 600,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              {
                role: 'user',
                content: [
                  { type: 'text', text: userText },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
          }),
        });

        if (!response.ok) continue; // 429 and friends: try the next model in the list
        const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = body.choices?.[0]?.message?.content;
        if (!content) continue;

        const parsed = ResponseSchema.safeParse(JSON.parse(stripFences(content)));
        if (!parsed.success) continue;

        const posterior = mapToCatalogue(parsed.data.candidates);
        if (Object.keys(posterior).length === 0) continue;
        return { posterior, model };
      } catch {
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }
}

/** Models return ```json ... ``` despite instructions. Observed in Gate 0.4 on both providers. */
export function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/**
 * Maps free-text condition names onto catalogue ids. A general model says "Malignant melanoma"
 * or "Melanocytic Nevi"; only exact-id and display-name matches are accepted, and anything else
 * is dropped. Fuzzy-matching an unrecognised label onto a diagnosis would be inventing evidence.
 */
export function mapToCatalogue(
  candidates: Array<{ condition: string; probability: number }>,
): Partial<Record<ConditionId, number>> {
  const byName = new Map<string, ConditionId>();
  for (const c of CONDITIONS) {
    byName.set(c.id, c.id);
    byName.set(c.displayName.toLowerCase(), c.id);
  }
  const out: Partial<Record<ConditionId, number>> = {};
  for (const candidate of candidates) {
    const key = candidate.condition.trim().toLowerCase().replace(/\s+/g, '_');
    const id = byName.get(key) ?? byName.get(candidate.condition.trim().toLowerCase());
    if (!id || id === 'insufficient_evidence') continue;
    out[id] = Math.max(out[id] ?? 0, candidate.probability);
  }
  return out;
}

async function toJpegDataUrl(frame: RgbaImage): Promise<string> {
  const jpeg = await sharp(Buffer.from(frame.data), {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}
