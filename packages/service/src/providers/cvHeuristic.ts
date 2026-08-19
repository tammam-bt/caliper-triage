/**
 * The always-available provider: classical computer vision, no model weights, no network.
 *
 * It is the default everywhere, and the fallback when a neural provider times out or is rate
 * limited. That matters more than it sounds: a triage tool whose only inference path is a remote
 * API is a triage tool that stops working when someone else's service has a bad day.
 */
import { aggregateFrameFeatures, extractFeatures } from '@caliper/core';
import type { ImageFeatures, QualityReport } from '@caliper/core';
import type { InferenceProvider, ProviderOutput } from '../ports.js';

export class CvHeuristicProvider implements InferenceProvider {
  readonly id = 'cv-heuristic';
  readonly modelId = 'abcd-heuristic-v1';

  async infer({ frames }: Parameters<InferenceProvider['infer']>[0]): Promise<ProviderOutput> {
    const extracted = frames.map((frame) => extractFeatures(frame));
    const featureList: ImageFeatures[] = extracted.map((e) => e.features);
    const { aggregate, keyFrameIndex } = aggregateFrameFeatures(featureList);
    const quality: QualityReport = extracted[keyFrameIndex]!.quality;

    return {
      quality,
      features: aggregate,
      ...(featureList.length > 1 ? { frameFeatures: featureList } : {}),
    };
  }
}
