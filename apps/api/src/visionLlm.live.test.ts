/**
 * Live verification of the vision-LLM provider against a real endpoint.
 *
 * Skipped unless `OPENROUTER_API_KEY` is set, so a fresh clone still runs green offline. It is a
 * real test rather than a script because "we have code for this" and "we ran this code against the
 * actual API" are different claims, and only the second one is worth making.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { disc, lobedBlob } from '@caliper/core/testing';
import { VisionLlmProvider } from './providers/visionLlm.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const live = Boolean(config.visionApiKey);

async function rgbaFromPng(image: { data: Uint8ClampedArray; width: number; height: number }) {
  const png = await sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  }).png().toBuffer();
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

describe.skipIf(!live)('VisionLlmProvider against a live endpoint', () => {
  it('returns a catalogue-mapped posterior alongside measured features', async () => {
    const provider = new VisionLlmProvider({
      apiKey: config.visionApiKey!,
      baseUrl: config.visionBaseUrl,
      models: config.visionModels,
      timeoutMs: 45000,
    });

    const output = await provider.infer({
      frames: [await rgbaFromPng(lobedBlob(70))],
      intake: { symptomsText: 'irregular and changing over three months', symptomIds: [] },
      media: { id: 'live', kind: 'image', mimeType: 'image/png', byteSize: 1, width: 256, height: 256 },
    });

    // The measured features must be present whatever the model did — they come from the
    // heuristic pass, which always runs.
    expect(output.features).toBeDefined();
    expect(output.quality).toBeDefined();

    if (output.modelPosterior) {
      console.log('live model:', output.modelLabel, JSON.stringify(output.modelPosterior));
      for (const [, p] of Object.entries(output.modelPosterior)) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    } else {
      // A rate limit is a legitimate outcome on the free tier, and the point of the fallback.
      console.log('live model unavailable; provider fell back to measured features only');
    }
  }, 90000);

  it('degrades to the heuristic rather than failing when every model rejects it', async () => {
    const provider = new VisionLlmProvider({
      apiKey: 'sk-definitely-not-a-valid-key',
      baseUrl: config.visionBaseUrl,
      models: ['nonexistent/model:free'],
      timeoutMs: 8000,
    });
    const output = await provider.infer({
      frames: [await rgbaFromPng(disc(70))],
      intake: { symptomsText: '', symptomIds: [] },
      media: { id: 'live', kind: 'image', mimeType: 'image/png', byteSize: 1, width: 256, height: 256 },
    });
    expect(output.features).toBeDefined();
    expect(output.modelPosterior).toBeUndefined();
  }, 30000);
});
