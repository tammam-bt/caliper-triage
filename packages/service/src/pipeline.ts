/**
 * The analysis pipeline: a linear stage machine that emits an event per transition.
 *
 * Every stage is wrapped so that a throw becomes a terminal `failed` analysis with a message,
 * rather than a promise that never settles. A UI waiting on a job that silently died is the worst
 * outcome available here, so it is the one behaviour with a dedicated test.
 */
import {
  aggregateFrameFeatures, extractFeatures, fuse, InferenceResultSchema,
} from '@caliper/core';
import type { Analysis, InferenceResult, PipelineEvent, Stage } from '@caliper/core';
import type { ServiceDeps } from './ports.js';

/** Progress reported at the *completion* of each stage. */
export const STAGE_PROGRESS: Record<Stage, number> = {
  received: 0.05,
  preprocess: 0.25,
  features: 0.55,
  inference: 0.8,
  fusion: 0.95,
  complete: 1,
};

export const MAX_VIDEO_FRAMES = 12;

export class PipelineCancelled extends Error {
  constructor() {
    super('Analysis cancelled');
    this.name = 'PipelineCancelled';
  }
}

interface RunOptions {
  signal: { cancelled: boolean };
}

export async function runPipeline(
  deps: ServiceDeps,
  analysisId: string,
  { signal }: RunOptions,
): Promise<Analysis> {
  const started = Date.now();

  const emit = async (stage: Stage, message?: string): Promise<Analysis> => {
    if (signal.cancelled) throw new PipelineCancelled();
    const patch = {
      status: 'running' as const,
      stage,
      progress: STAGE_PROGRESS[stage],
      updatedAt: deps.clock.now().toISOString(),
    };
    const updated = await deps.repository.update(analysisId, patch);
    publish(deps, { ...toEvent(updated), ...(message ? { message } : {}) });
    return updated;
  };

  try {
    const analysis = await emit('received', 'Submission accepted');

    // --- preprocess: fetch bytes, decode, sample frames ---------------------
    const stored = await deps.mediaStore.get(analysis.media.id);
    if (!stored) throw new Error(`Media ${analysis.media.id} is missing from the store`);
    const frames = await deps.frameExtractor.extract(stored, { maxFrames: MAX_VIDEO_FRAMES });
    if (frames.length === 0) throw new Error('No decodable frames were found in the upload');
    await emit(
      'preprocess',
      frames.length > 1 ? `Sampled ${frames.length} frames` : 'Decoded 1 frame',
    );

    // --- features -----------------------------------------------------------
    const perFrame = frames.map((frame) => extractFeatures(frame));
    const { aggregate, keyFrameIndex } = aggregateFrameFeatures(perFrame.map((p) => p.features));
    // The key frame's quality report is authoritative: a clip is usable if any frame is.
    const quality = perFrame[keyFrameIndex]!.quality;
    await emit(
      'features',
      frames.length > 1
        ? `Measured ${frames.length} frames, key frame ${keyFrameIndex + 1}`
        : 'Measured lesion geometry and colour',
    );

    // --- inference ------------------------------------------------------------
    const providerOutput = await deps.provider.infer({
      frames,
      intake: analysis.intake,
      media: analysis.media,
    });
    await emit('inference', `${deps.provider.modelId} returned`);

    // --- fusion ---------------------------------------------------------------
    const features = providerOutput.features ?? aggregate;
    const mergedQuality = providerOutput.quality.usable === false ? providerOutput.quality : quality;

    const fused = fuse({
      intake: analysis.intake,
      quality: mergedQuality,
      features,
      ...(providerOutput.modelPosterior ? { modelPosterior: providerOutput.modelPosterior } : {}),
      ...(providerOutput.modelLabel ? { modelLabel: providerOutput.modelLabel } : {}),
    });

    const result: InferenceResult = InferenceResultSchema.parse({
      provider: deps.provider.id,
      modelId: deps.provider.modelId,
      candidates: fused.candidates,
      abstained: fused.abstained,
      ...(fused.abstainReason ? { abstainReason: fused.abstainReason } : {}),
      confidence: fused.confidence,
      acuity: fused.acuity,
      quality: mergedQuality,
      features,
      ...(perFrame.length > 1 ? { frameFeatures: perFrame.map((p) => p.features) } : {}),
      computeMs: Date.now() - started,
    });
    await emit('fusion', 'Combined image, intake and model evidence');

    if (signal.cancelled) throw new PipelineCancelled();
    const completed = await deps.repository.update(analysisId, {
      status: 'complete',
      stage: 'complete',
      progress: 1,
      result,
      updatedAt: deps.clock.now().toISOString(),
    });
    publish(deps, toEvent(completed));
    return completed;
  } catch (error) {
    const cancelled = error instanceof PipelineCancelled;
    const message = error instanceof Error ? error.message : String(error);
    const failed = await deps.repository.update(analysisId, {
      status: cancelled ? 'cancelled' : 'failed',
      progress: 1,
      error: message,
      updatedAt: deps.clock.now().toISOString(),
    });
    publish(deps, toEvent(failed));
    return failed;
  }
}

function toEvent(a: Analysis): PipelineEvent {
  return {
    analysisId: a.id,
    status: a.status,
    stage: a.stage,
    progress: a.progress,
    at: a.updatedAt,
    ...(a.result ? { result: a.result } : {}),
    ...(a.error ? { error: a.error } : {}),
  };
}

/**
 * A subscriber that throws must not take the pipeline down with it. In `apps/api` this bus is
 * Socket.IO, and a disconnecting client is an ordinary event, not a reason to fail an analysis.
 */
function publish(deps: ServiceDeps, event: PipelineEvent): void {
  try {
    deps.events.publish(event);
  } catch {
    /* a failed notification is not a failed analysis */
  }
}
