/**
 * The API, running in this tab.
 *
 * Every line below the `submitAnalysis` call is the same code `apps/api` executes: the same
 * use-cases, the same Zod validation, the same pipeline, the same event contract. What differs is
 * the adapters underneath — a Map instead of MongoDB, an in-memory blob store instead of GridFS,
 * a canvas instead of ffmpeg.
 *
 * This exists because GitHub Pages cannot run a server, and the two obvious responses to that are
 * both bad: shipping no backend at all, or faking one with canned responses. Running the real
 * handlers against different adapters is the third option, and it is the one that keeps the demo
 * honest — the numbers on screen are computed, not stored.
 */
import {
  ImmediateJobQueue, MemoryAnalysisRepository, MemoryEventBus, MemoryMediaStore, RandomIdGen,
  SystemClock, getAnalysis, submitAnalysis, type InferenceProvider, type ServiceDeps,
} from '@caliper/service';
import type { Analysis, PipelineEvent, SubmitAnalysisResponse } from '@caliper/core';
import { BrowserFrameExtractor } from '../adapters/browserFrameExtractor.js';
import { ExchangeLog, type SubmitArgs, type Transport } from './types.js';

export class InBrowserTransport implements Transport {
  readonly mode = 'in-browser' as const;
  readonly description = 'API handlers running in this tab';

  private readonly log = new ExchangeLog();
  private readonly bus = new MemoryEventBus();
  private readonly frames = new BrowserFrameExtractor();
  private readonly queue = new ImmediateJobQueue();
  private readonly repository = new MemoryAnalysisRepository();
  private readonly mediaStore = new MemoryMediaStore();
  private readonly deps: ServiceDeps;

  constructor(provider: InferenceProvider) {
    this.deps = {
      repository: this.repository,
      mediaStore: this.mediaStore,
      frameExtractor: this.frames,
      provider,
      events: this.bus,
      queue: this.queue,
      clock: new SystemClock(),
      ids: new RandomIdGen(),
    };
  }

  /** Swapped when the user opts into the on-device model mid-session. */
  setProvider(provider: InferenceProvider): void {
    this.deps.provider = provider;
  }

  async submit(args: SubmitArgs): Promise<SubmitAnalysisResponse> {
    this.log.record({
      verb: 'POST',
      path: '/api/v1/analyses',
      status: '…',
      request: {
        intake: args.intake,
        media: args.media,
        body: `<${args.bytes.byteLength} bytes of ${args.media.mimeType}>`,
        headers: args.idempotencyKey ? { 'Idempotency-Key': args.idempotencyKey } : {},
      },
    });

    const response = await submitAnalysis(this.deps, {
      intake: args.intake,
      media: args.media,
      bytes: args.bytes,
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    });

    // The service mints the media id; the decoded frames are registered against it so the
    // extractor can find them without decoding the file a second time.
    this.frames.register(`${response.analysisId}-media`, args.frames);

    this.log.record({ verb: 'POST', path: '/api/v1/analyses', status: 202, response });
    return response;
  }

  async get(analysisId: string): Promise<Analysis> {
    const analysis = await getAnalysis(this.deps, analysisId);
    this.log.record({
      verb: 'GET',
      path: `/api/v1/analyses/${analysisId}`,
      status: 200,
      response: summarise(analysis),
    });
    return analysis;
  }

  subscribe(analysisId: string, onEvent: (event: PipelineEvent) => void): () => void {
    return this.bus.subscribe((event) => {
      if (event.analysisId !== analysisId) return;
      this.log.record({
        verb: 'WS',
        path: `analysis:${analysisId}`,
        status: event.stage,
        response: { stage: event.stage, status: event.status, progress: event.progress, ...(event.message ? { message: event.message } : {}) },
      });
      onEvent(event);
    });
  }

  exchanges() {
    return this.log.all();
  }

  onExchange(fn: (rows: import('./types.js').Exchange[]) => void) {
    return this.log.subscribe(fn);
  }
}

/** The full result is thousands of contour points; the inspector wants the shape, not the volume. */
function summarise(analysis: Analysis): unknown {
  if (!analysis.result) {
    return { id: analysis.id, status: analysis.status, stage: analysis.stage, progress: analysis.progress };
  }
  const { result } = analysis;
  return {
    id: analysis.id,
    status: analysis.status,
    result: {
      provider: result.provider,
      modelId: result.modelId,
      acuity: result.acuity,
      confidence: result.confidence,
      abstained: result.abstained,
      computeMs: result.computeMs,
      candidates: result.candidates.slice(0, 3).map((c) => ({
        conditionId: c.conditionId,
        probability: c.probability,
      })),
      features: result.features
        ? { ...result.features, contour: `<${result.features.contour.length} points>` }
        : undefined,
    },
  };
}
