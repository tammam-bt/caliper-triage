import { beforeEach, describe, expect, it } from 'vitest';
import { disc, lobedBlob } from '@caliper/core/testing';
import type { Intake, MediaUpload, RgbaImage } from '@caliper/core';
import { CvHeuristicProvider } from './providers/cvHeuristic.js';
import {
  FixedClock, ImmediateJobQueue, MemoryAnalysisRepository, MemoryEventBus, MemoryMediaStore,
  SequentialIdGen,
} from './adapters/memory.js';
import { StaticFrameExtractor } from './adapters/rgbaFrames.js';
import type { InferenceProvider, ServiceDeps } from './ports.js';
import { cancelAnalysis, getAnalysis, listAnalyses, NotFoundError, submitAnalysis, ValidationError } from './usecases.js';

const IMAGE: MediaUpload = {
  kind: 'image', mimeType: 'image/png', byteSize: 1024, width: 256, height: 256,
};
/** The service mints media ids as `<analysisId>-media`; fixtures are keyed to match. */
const mediaIdFor = (analysisId: string) => `${analysisId}-media`;
const INTAKE: Intake = { symptomsText: 'changing and bleeding', symptomIds: [] };

interface Harness {
  deps: ServiceDeps;
  events: MemoryEventBus;
  queue: ImmediateJobQueue;
  frames: Map<string, RgbaImage[]>;
}

function harness(provider: InferenceProvider = new CvHeuristicProvider()): Harness {
  const frames = new Map<string, RgbaImage[]>();
  const events = new MemoryEventBus();
  const queue = new ImmediateJobQueue();
  const deps: ServiceDeps = {
    repository: new MemoryAnalysisRepository(),
    mediaStore: new MemoryMediaStore(),
    frameExtractor: new StaticFrameExtractor(frames),
    provider,
    events,
    queue,
    clock: new FixedClock(),
    ids: new SequentialIdGen(),
  };
  return { deps, events, queue, frames };
}

async function submitAndRun(h: Harness, over: Partial<{ intake: Intake; media: MediaUpload }> = {}) {
  const media = over.media ?? IMAGE;
  h.frames.set(mediaIdFor('analysis-1'), [disc(70)]);
  const res = await submitAnalysis(h.deps, {
    intake: over.intake ?? INTAKE,
    media,
    bytes: new Uint8Array([1, 2, 3]),
  });
  await h.queue.drain();
  return res;
}

describe('submitAnalysis', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('returns 202-shaped data immediately, before the pipeline runs', async () => {
    h.frames.set(mediaIdFor('analysis-1'), [disc(70)]);
    const res = await submitAnalysis(h.deps, { intake: INTAKE, media: IMAGE, bytes: new Uint8Array([1]) });
    expect(res.status).toBe('queued');
    expect(res.analysisId).toBe('analysis-1');
    expect(res.channel).toBe('analysis:analysis-1');
    await h.queue.drain();
  });

  it('rejects a malformed submission with a validation error', async () => {
    await expect(
      submitAnalysis(h.deps, { intake: INTAKE, media: { ...IMAGE, width: -5 }, bytes: new Uint8Array([1]) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns the original analysis when an idempotency key is replayed', async () => {
    h.frames.set(mediaIdFor('analysis-1'), [disc(70)]);
    const first = await submitAnalysis(h.deps, {
      intake: INTAKE, media: IMAGE, bytes: new Uint8Array([1]), idempotencyKey: 'retry-key-1234',
    });
    const second = await submitAnalysis(h.deps, {
      intake: INTAKE, media: IMAGE, bytes: new Uint8Array([1]), idempotencyKey: 'retry-key-1234',
    });
    await h.queue.drain();
    expect(second.analysisId).toBe(first.analysisId);
    expect(await listAnalyses(h.deps)).toHaveLength(1);
  });
});

describe('happy path', () => {
  it('emits exactly the documented stage sequence, in order', async () => {
    const h = harness();
    await submitAndRun(h);
    expect(h.events.log.map((e) => e.stage)).toEqual([
      'received', 'preprocess', 'features', 'inference', 'fusion', 'complete',
    ]);
  });

  it('reports monotonically non-decreasing progress ending at 1', async () => {
    const h = harness();
    await submitAndRun(h);
    const progress = h.events.log.map((e) => e.progress);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    }
    expect(progress.at(-1)).toBe(1);
  });

  it('carries the result only on the terminal event', async () => {
    const h = harness();
    await submitAndRun(h);
    const withResult = h.events.log.filter((e) => e.result);
    expect(withResult).toHaveLength(1);
    expect(withResult[0]!.status).toBe('complete');
  });

  it('stores a schema-valid result with a confidence and a full differential', async () => {
    const h = harness();
    const { analysisId } = await submitAndRun(h);
    const analysis = await getAnalysis(h.deps, analysisId);
    expect(analysis.status).toBe('complete');
    expect(analysis.result).toBeDefined();
    expect(analysis.result!.candidates.length).toBe(8);
    expect(analysis.result!.confidence).toBeGreaterThan(0);
    expect(analysis.result!.provider).toBe('cv-heuristic');
    expect(analysis.result!.computeMs).toBeGreaterThanOrEqual(0);
  });

  it('produces different results for different media', async () => {
    // The guarantee that matters: the output is a function of the pixels, not of the code path.
    const a = harness();
    a.frames.set(mediaIdFor('analysis-1'), [disc(70)]);
    await submitAnalysis(a.deps, { intake: INTAKE, media: IMAGE, bytes: new Uint8Array([1]) });
    await a.queue.drain();

    const b = harness();
    b.frames.set(mediaIdFor('analysis-1'), [lobedBlob(70)]);
    await submitAnalysis(b.deps, { intake: INTAKE, media: IMAGE, bytes: new Uint8Array([1]) });
    await b.queue.drain();

    const ra = (await getAnalysis(a.deps, 'analysis-1')).result!;
    const rb = (await getAnalysis(b.deps, 'analysis-1')).result!;
    expect(ra.features!.borderIrregularity).not.toBe(rb.features!.borderIrregularity);
  });
});

describe('video', () => {
  it('samples every frame and records per-frame features', async () => {
    const h = harness();
    const media: MediaUpload = { ...IMAGE, kind: 'video', mimeType: 'video/mp4', durationMs: 3000 };
    h.frames.set(mediaIdFor('analysis-1'), [disc(70), lobedBlob(70), disc(65)]);
    await submitAnalysis(h.deps, { intake: INTAKE, media, bytes: new Uint8Array([1]) });
    await h.queue.drain();

    const result = (await getAnalysis(h.deps, 'analysis-1')).result!;
    expect(result.frameFeatures).toHaveLength(3);
    const preprocess = h.events.log.find((e) => e.stage === 'preprocess');
    expect(preprocess!.message).toMatch(/3 frames/);
  });
});

describe('failure handling', () => {
  it('fails the analysis instead of hanging when the provider throws', async () => {
    // The worst available outcome is a job that never settles, leaving the UI spinning forever.
    const exploding: InferenceProvider = {
      id: 'exploding', modelId: 'boom-v1',
      async infer() { throw new Error('model endpoint returned 503'); },
    };
    const h = harness(exploding);
    const { analysisId } = await submitAndRun(h);
    const analysis = await getAnalysis(h.deps, analysisId);
    expect(analysis.status).toBe('failed');
    expect(analysis.error).toMatch(/503/);
    expect(h.events.log.at(-1)!.status).toBe('failed');
    expect(h.events.log.at(-1)!.progress).toBe(1);
  });

  it('fails cleanly when the media is missing from the store', async () => {
    const h = harness();
    h.frames.set(mediaIdFor('analysis-1'), [disc(70)]);
    const { analysisId } = await submitAnalysis(h.deps, {
      intake: INTAKE, media: IMAGE, bytes: new Uint8Array([1]),
    });
    await h.deps.mediaStore.delete(mediaIdFor('analysis-1'));
    await h.queue.drain();
    const analysis = await getAnalysis(h.deps, analysisId);
    expect(analysis.status).toBe('failed');
    expect(analysis.error).toMatch(/missing from the store/);
  });

  it('fails cleanly when no frames can be decoded', async () => {
    const h = harness();
    h.frames.set(mediaIdFor('analysis-1'), []);
    const { analysisId } = await submitAnalysis(h.deps, {
      intake: INTAKE, media: IMAGE, bytes: new Uint8Array([1]),
    });
    await h.queue.drain();
    expect((await getAnalysis(h.deps, analysisId)).error).toMatch(/No decodable frames/);
  });

  it('does not let a throwing event subscriber fail the analysis', async () => {
    // Socket.IO fans out to whoever is connected; a disconnecting client is not a model failure.
    const h = harness();
    const hostile = new MemoryEventBus();
    hostile.subscribe(() => { throw new Error('subscriber exploded'); });
    h.deps.events = hostile;
    const { analysisId } = await submitAndRun(h);
    expect((await getAnalysis(h.deps, analysisId)).status).toBe('complete');
  });

  it('reports a missing analysis as not found', async () => {
    const h = harness();
    await expect(getAnalysis(h.deps, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('cancellation', () => {
  it('stops a running analysis and marks it cancelled', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow: InferenceProvider = {
      id: 'slow', modelId: 'slow-v1',
      async infer() { await gate; return { quality: { usable: true, issues: [] } }; },
    };
    const h = harness(slow);
    h.frames.set(mediaIdFor('analysis-1'), [disc(70)]);
    const { analysisId } = await submitAnalysis(h.deps, {
      intake: INTAKE, media: IMAGE, bytes: new Uint8Array([1]),
    });

    await cancelAnalysis(h.deps, analysisId);
    release();
    await h.queue.drain();

    const analysis = await getAnalysis(h.deps, analysisId);
    expect(analysis.status).toBe('cancelled');
    expect(analysis.result).toBeUndefined();
  });

  it('leaves an already-complete analysis alone', async () => {
    const h = harness();
    const { analysisId } = await submitAndRun(h);
    const after = await cancelAnalysis(h.deps, analysisId);
    expect(after.status).toBe('complete');
  });
});
