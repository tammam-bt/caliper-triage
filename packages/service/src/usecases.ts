/**
 * The use-cases. This is the API, in the sense that matters: Express routes and the browser's
 * in-process transport are both thin adapters over exactly these four functions.
 */
import {
  AnalysisSchema, MediaRefSchema, SubmitAnalysisRequestSchema,
} from '@caliper/core';
import type { Analysis, SubmitAnalysisResponse } from '@caliper/core';
import { runPipeline } from './pipeline.js';
import type { ServiceDeps } from './ports.js';

export class NotFoundError extends Error {
  readonly code = 'not_found';
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  readonly code = 'invalid_request';
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface SubmitInput {
  intake: unknown;
  media: unknown;
  bytes: Uint8Array;
  idempotencyKey?: string;
}

/**
 * Accept a case and queue it. Returns immediately with 202-shaped data: the caller polls or
 * subscribes. Nothing here waits for a model, because in production a model can take a minute and
 * an HTTP request cannot.
 */
export async function submitAnalysis(
  deps: ServiceDeps,
  input: SubmitInput,
): Promise<SubmitAnalysisResponse> {
  const parsed = SubmitAnalysisRequestSchema.safeParse({
    intake: input.intake,
    media: input.media,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
  if (!parsed.success) {
    throw new ValidationError('Submission failed validation', parsed.error.flatten());
  }
  const { intake, media, idempotencyKey } = parsed.data;

  // Replaying a submission must not start a second analysis. Mobile clients retry on flaky
  // networks, and without this a poor connection quietly doubles the inference bill.
  if (idempotencyKey) {
    const existing = await deps.repository.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return { analysisId: existing.id, status: existing.status, channel: channelFor(existing.id) };
    }
  }

  const id = deps.ids.next();
  const now = deps.clock.now().toISOString();
  const mediaRef = MediaRefSchema.parse({ ...media, id: media && typeof media === 'object' && 'id' in media && (media as { id?: string }).id ? (media as { id: string }).id : id });

  await deps.mediaStore.put({ ref: mediaRef, bytes: input.bytes });

  const analysis: Analysis = AnalysisSchema.parse({
    id,
    status: 'queued',
    stage: 'received',
    progress: 0,
    intake,
    media: mediaRef,
    createdAt: now,
    updatedAt: now,
  });

  await deps.repository.create(analysis, idempotencyKey);
  deps.queue.enqueue(id, (signal) => runPipeline(deps, id, { signal }).then(() => undefined));

  return { analysisId: id, status: 'queued', channel: channelFor(id) };
}

export async function getAnalysis(deps: ServiceDeps, id: string): Promise<Analysis> {
  const found = await deps.repository.get(id);
  if (!found) throw new NotFoundError(`Analysis ${id}`);
  return found;
}

export async function listAnalyses(deps: ServiceDeps, limit = 20): Promise<Analysis[]> {
  return deps.repository.list({ limit });
}

export async function cancelAnalysis(deps: ServiceDeps, id: string): Promise<Analysis> {
  const found = await deps.repository.get(id);
  if (!found) throw new NotFoundError(`Analysis ${id}`);
  if (found.status === 'complete' || found.status === 'failed') return found;

  deps.queue.cancel(id);
  const updated = await deps.repository.update(id, {
    status: 'cancelled',
    progress: 1,
    updatedAt: deps.clock.now().toISOString(),
  });
  deps.events.publish({
    analysisId: id,
    status: updated.status,
    stage: updated.stage,
    progress: updated.progress,
    at: updated.updatedAt,
  });
  return updated;
}

export function channelFor(analysisId: string): string {
  return `analysis:${analysisId}`;
}
