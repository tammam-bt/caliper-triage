/**
 * The ports.
 *
 * Everything the application layer needs from the outside world, expressed as interfaces it owns.
 * `apps/api` binds these to Mongo, GridFS, ffmpeg and Socket.IO; `apps/web` binds them to a Map, a
 * Blob, a `<video>` element and an `EventTarget`. Neither implementation appears in this package,
 * which is what lets the identical pipeline run on a server and inside a static page.
 */
import type {
  Analysis, ConditionId, ImageFeatures, Intake, MediaRef, PipelineEvent, QualityReport,
} from '@caliper/core';
import type { RgbaImage } from '@caliper/core';

export interface StoredMedia {
  ref: MediaRef;
  bytes: Uint8Array;
}

export interface AnalysisRepository {
  create(analysis: Analysis, idempotencyKey?: string): Promise<Analysis>;
  get(id: string): Promise<Analysis | null>;
  update(id: string, patch: Partial<Analysis>): Promise<Analysis>;
  list(options?: { limit?: number }): Promise<Analysis[]>;
  /** Returns the analysis a previous submission with this key produced, if any. */
  findByIdempotencyKey(key: string): Promise<Analysis | null>;
}

export interface MediaStore {
  put(media: StoredMedia): Promise<void>;
  get(id: string): Promise<StoredMedia | null>;
  delete(id: string): Promise<void>;
}

/**
 * Turns stored bytes into RGBA frames. One frame for a still; N sampled frames for a video.
 * Implementations differ completely — ffmpeg on the server, `<video>` + canvas in the browser —
 * and the pipeline is indifferent to which it got.
 */
export interface FrameExtractor {
  extract(media: StoredMedia, options?: { maxFrames?: number }): Promise<RgbaImage[]>;
}

/** What a provider contributes. It reports evidence; it does not decide the answer. */
export interface ProviderOutput {
  quality: QualityReport;
  features?: ImageFeatures;
  frameFeatures?: ImageFeatures[];
  /** Optional posterior over conditions from a neural model. Need not be normalised. */
  modelPosterior?: Partial<Record<ConditionId, number>>;
  /** Shown in the evidence trace, e.g. "MobileCLIP S0 (zero-shot)". */
  modelLabel?: string;
}

export interface InferenceProvider {
  /** Stable identifier recorded on the result, e.g. "cv-heuristic". */
  readonly id: string;
  /** What actually produced the numbers, e.g. "abcd-heuristic-v1". Surfaced in the UI. */
  readonly modelId: string;
  infer(input: { frames: RgbaImage[]; intake: Intake; media: MediaRef }): Promise<ProviderOutput>;
}

export interface EventBus {
  publish(event: PipelineEvent): void;
}

export interface Clock {
  now(): Date;
}

export interface IdGen {
  next(): string;
}

/**
 * Deliberately minimal. In `apps/api` this is an in-process queue; in production it is BullMQ on
 * Redis with the work running in a separate process. The pipeline never learns which, so moving
 * from one to the other is a wiring change rather than a rewrite.
 */
export interface JobQueue {
  enqueue(jobId: string, run: (signal: { cancelled: boolean }) => Promise<void>): void;
  cancel(jobId: string): boolean;
}

export interface ServiceDeps {
  repository: AnalysisRepository;
  mediaStore: MediaStore;
  frameExtractor: FrameExtractor;
  provider: InferenceProvider;
  events: EventBus;
  queue: JobQueue;
  clock: Clock;
  ids: IdGen;
}
