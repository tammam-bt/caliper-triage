/**
 * In-memory adapters.
 *
 * Not test doubles. These are the adapters the deployed browser demo actually runs on, which is
 * why they enforce the same invariants a database would — an update to a missing row throws, and
 * stored records are cloned so a caller cannot mutate the store by holding on to a reference.
 */
import type { Analysis, PipelineEvent } from '@caliper/core';
import type {
  AnalysisRepository, Clock, EventBus, IdGen, JobQueue, MediaStore, StoredMedia,
} from '../ports.js';

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryAnalysisRepository implements AnalysisRepository {
  private readonly rows = new Map<string, Analysis>();
  private readonly byIdempotency = new Map<string, string>();

  async create(analysis: Analysis, idempotencyKey?: string): Promise<Analysis> {
    if (this.rows.has(analysis.id)) throw new Error(`Analysis ${analysis.id} already exists`);
    this.rows.set(analysis.id, clone(analysis));
    if (idempotencyKey) this.byIdempotency.set(idempotencyKey, analysis.id);
    return clone(analysis);
  }

  async get(id: string): Promise<Analysis | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }

  async update(id: string, patch: Partial<Analysis>): Promise<Analysis> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Analysis ${id} not found`);
    const next = { ...row, ...clone(patch) };
    this.rows.set(id, next);
    return clone(next);
  }

  async list({ limit = 20 }: { limit?: number } = {}): Promise<Analysis[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async findByIdempotencyKey(key: string): Promise<Analysis | null> {
    const id = this.byIdempotency.get(key);
    return id ? this.get(id) : null;
  }
}

export class MemoryMediaStore implements MediaStore {
  private readonly rows = new Map<string, StoredMedia>();

  async put(media: StoredMedia): Promise<void> {
    this.rows.set(media.ref.id, { ref: clone(media.ref), bytes: media.bytes });
  }

  async get(id: string): Promise<StoredMedia | null> {
    return this.rows.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

/** Fans events out to subscribers. The browser demo layers an `EventTarget` over this. */
export class MemoryEventBus implements EventBus {
  private readonly subscribers = new Set<(event: PipelineEvent) => void>();
  readonly log: PipelineEvent[] = [];

  publish(event: PipelineEvent): void {
    this.log.push(event);
    for (const fn of this.subscribers) fn(event);
  }

  subscribe(fn: (event: PipelineEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

/**
 * Runs jobs immediately, one at a time, on the caller's event loop.
 *
 * Honest about what it is: `apps/api` uses this too, and the port exists so that swapping in BullMQ
 * changes one line of wiring. What it does provide is real cancellation — the signal object is
 * checked at every stage boundary, so a cancelled job stops rather than finishing invisibly.
 */
export class ImmediateJobQueue implements JobQueue {
  private readonly running = new Map<string, { cancelled: boolean }>();
  private tail: Promise<void> = Promise.resolve();

  enqueue(jobId: string, run: (signal: { cancelled: boolean }) => Promise<void>): void {
    const signal = { cancelled: false };
    this.running.set(jobId, signal);
    this.tail = this.tail
      // Yield a macrotask before starting.
      //
      // The API returns 202 with a channel and expects the client to subscribe *next*. Starting
      // the job in the same microtask means the first stage event can be emitted before that
      // subscription exists, and the client silently misses it. In production there is always a
      // queue hop here; in-process there is not, so one is inserted deliberately rather than
      // leaving the ordering to chance.
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      .then(() => run(signal))
      .catch(() => undefined)
      .finally(() => {
        this.running.delete(jobId);
      });
  }

  cancel(jobId: string): boolean {
    const signal = this.running.get(jobId);
    if (!signal) return false;
    signal.cancelled = true;
    return true;
  }

  /** Test and shutdown helper: resolves when the queue has drained. */
  async drain(): Promise<void> {
    await this.tail;
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Monotonic fake clock. Timestamps order correctly without any real time passing. */
export class FixedClock implements Clock {
  private ms: number;
  constructor(start = Date.UTC(2026, 0, 1)) {
    this.ms = start;
  }
  now(): Date {
    this.ms += 1000;
    return new Date(this.ms);
  }
}

export class RandomIdGen implements IdGen {
  next(): string {
    // `crypto.randomUUID` is present in Node 19+ and every browser this targets.
    return globalThis.crypto.randomUUID();
  }
}

export class SequentialIdGen implements IdGen {
  private n = 0;
  constructor(private readonly prefix = 'analysis') {}
  next(): string {
    this.n += 1;
    return `${this.prefix}-${this.n}`;
  }
}
