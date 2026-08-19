/**
 * The mobile app's analysis pipeline.
 *
 * Identical in structure to the web console's: the same `@caliper/service` use-cases over the same
 * ports, with adapters appropriate to the platform. The only genuinely different part is decoding —
 * React Native has no canvas, so pixels come from `expo-image-manipulator` plus a base64 read.
 *
 * Pointing this at the real API instead is the same one-line transport swap the web app uses.
 */
import {
  CvHeuristicProvider, ImmediateJobQueue, MemoryAnalysisRepository, MemoryEventBus,
  MemoryMediaStore, RandomIdGen, StaticFrameExtractor, SystemClock, getAnalysis, submitAnalysis,
  type ServiceDeps,
} from '@caliper/service';
import type { Analysis, Intake, MediaUpload, PipelineEvent, RgbaImage } from '@caliper/core';

export function createPipeline() {
  const frames = new Map<string, RgbaImage[]>();
  const bus = new MemoryEventBus();
  const queue = new ImmediateJobQueue();

  const deps: ServiceDeps = {
    repository: new MemoryAnalysisRepository(),
    mediaStore: new MemoryMediaStore(),
    frameExtractor: new StaticFrameExtractor(frames),
    provider: new CvHeuristicProvider(),
    events: bus,
    queue,
    clock: new SystemClock(),
    ids: new RandomIdGen(),
  };

  return {
    async run(
      intake: Intake,
      media: MediaUpload,
      decoded: RgbaImage[],
      onEvent: (event: PipelineEvent) => void,
    ): Promise<Analysis> {
      const accepted = await submitAnalysis(deps, {
        intake,
        media,
        bytes: new Uint8Array(0),
        idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      });
      frames.set(`${accepted.analysisId}-media`, decoded);

      const unsubscribe = bus.subscribe((event) => {
        if (event.analysisId === accepted.analysisId) onEvent(event);
      });

      try {
        for (let i = 0; i < 300; i++) {
          const analysis = await getAnalysis(deps, accepted.analysisId);
          if (analysis.status === 'complete' || analysis.status === 'failed') return analysis;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('Timed out waiting for the assessment.');
      } finally {
        unsubscribe();
      }
    },
  };
}
