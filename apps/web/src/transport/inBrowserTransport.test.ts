/**
 * Tests for the transport the deployed demo actually runs on.
 *
 * This is the code path that makes the GitHub Pages deployment more than a mock, so it gets tested
 * like production code rather than treated as demo scaffolding. No browser is needed: the frames
 * are already decoded RGBA by the time the transport sees them, so the whole in-browser pipeline
 * runs under Node.
 */
import { describe, expect, it, vi } from 'vitest';
import { CvHeuristicProvider } from '@caliper/service';
import { disc, lobedBlob } from '@caliper/core/testing';
import type { Analysis, MediaUpload, PipelineEvent } from '@caliper/core';
import { InBrowserTransport } from './inBrowserTransport.js';
import { ExchangeLog } from './types.js';

const MEDIA: MediaUpload = {
  kind: 'image', mimeType: 'image/png', byteSize: 4096, width: 256, height: 256,
};

const INTAKE = { symptomsText: 'changing and bleeding', symptomIds: [] };

function makeTransport() {
  return new InBrowserTransport(new CvHeuristicProvider());
}

async function runToCompletion(
  transport: InBrowserTransport,
  frames = [disc(70)],
): Promise<{ analysis: Analysis; events: PipelineEvent[] }> {
  const events: PipelineEvent[] = [];
  const accepted = await transport.submit({
    intake: INTAKE, media: MEDIA, bytes: new Uint8Array([1, 2, 3]), frames,
  });
  const unsubscribe = transport.subscribe(accepted.analysisId, (e) => events.push(e));

  for (let i = 0; i < 200; i++) {
    const analysis = await transport.get(accepted.analysisId);
    if (analysis.status === 'complete' || analysis.status === 'failed') {
      unsubscribe();
      return { analysis, events };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  unsubscribe();
  throw new Error('analysis did not settle');
}

describe('InBrowserTransport', () => {
  it('reports what it is, so the UI can say so honestly', () => {
    const t = makeTransport();
    expect(t.mode).toBe('in-browser');
    expect(t.description).toMatch(/this tab/i);
  });

  it('returns 202-shaped data with a subscription channel', async () => {
    const t = makeTransport();
    const accepted = await t.submit({
      intake: INTAKE, media: MEDIA, bytes: new Uint8Array([1]), frames: [disc(70)],
    });
    expect(accepted.status).toBe('queued');
    expect(accepted.channel).toBe(`analysis:${accepted.analysisId}`);
  });

  it('runs the real pipeline to a real result', async () => {
    const { analysis } = await runToCompletion(makeTransport());
    expect(analysis.status).toBe('complete');
    expect(analysis.result!.candidates).toHaveLength(8);
    expect(analysis.result!.features!.contour.length).toBeGreaterThan(20);
    expect(analysis.result!.confidence).toBeGreaterThan(0);
    // The ceiling from fusion must hold through this transport too.
    expect(analysis.result!.confidence).toBeLessThanOrEqual(0.85);
  });

  it('emits the documented stage sequence', async () => {
    const { events } = await runToCompletion(makeTransport());
    expect(events.map((e) => e.stage)).toEqual([
      'received', 'preprocess', 'features', 'inference', 'fusion', 'complete',
    ]);
  });

  it('measures the frames it was handed, not a cached image', async () => {
    // The regression guard for the media-id collision found in the API: two submissions on one
    // transport instance must not share stored media.
    const t = makeTransport();
    const a = await runToCompletion(t, [disc(70)]);
    const b = await runToCompletion(t, [lobedBlob(70)]);
    expect(a.analysis.result!.features!.borderIrregularity)
      .not.toBe(b.analysis.result!.features!.borderIrregularity);
  });

  it('aggregates multiple frames as a video', async () => {
    const { analysis } = await runToCompletion(makeTransport(), [disc(70), lobedBlob(70), disc(65)]);
    expect(analysis.result!.frameFeatures).toHaveLength(3);
  });

  it('records request and response envelopes for the inspector', async () => {
    const t = makeTransport();
    await runToCompletion(t);
    const rows = t.exchanges();
    const post = rows.find((r) => r.verb === 'POST');
    expect(post?.path).toBe('/api/v1/analyses');
    expect(rows.some((r) => r.verb === 'GET')).toBe(true);
    expect(rows.some((r) => r.verb === 'WS')).toBe(true);
  });

  it('does not serialise thousands of contour points into the inspector', async () => {
    const t = makeTransport();
    await runToCompletion(t);
    // Filter on GET rows: a websocket row for the *features stage* also contains the word.
    const withResult = t
      .exchanges()
      .filter((r) => r.verb === 'GET' && JSON.stringify(r.response ?? '').includes('"features"'));
    expect(withResult.length).toBeGreaterThan(0);
    for (const row of withResult) {
      expect(JSON.stringify(row.response)).toMatch(/<\d+ points>/);
    }
  });

  it('notifies subscribers when new exchanges are recorded', async () => {
    const t = makeTransport();
    const seen = vi.fn();
    t.onExchange(seen);
    await runToCompletion(t);
    expect(seen).toHaveBeenCalled();
  });

  it('only delivers events for the analysis subscribed to', async () => {
    const t = makeTransport();
    const events: PipelineEvent[] = [];
    t.subscribe('some-other-analysis', (e) => events.push(e));
    await runToCompletion(t);
    expect(events).toHaveLength(0);
  });

  it('honours an idempotency key', async () => {
    const t = makeTransport();
    const args = {
      intake: INTAKE, media: MEDIA, bytes: new Uint8Array([1]),
      frames: [disc(70)], idempotencyKey: 'browser-replay-0001',
    };
    const first = await t.submit(args);
    const second = await t.submit(args);
    expect(second.analysisId).toBe(first.analysisId);
  });
});

describe('ExchangeLog', () => {
  it('keeps the panel bounded on a long session', () => {
    const log = new ExchangeLog();
    for (let i = 0; i < 120; i++) log.record({ verb: 'GET', path: `/x/${i}`, status: 200 });
    const rows = log.all();
    expect(rows).toHaveLength(40);
    // Oldest dropped, newest kept.
    expect(rows.at(-1)!.path).toBe('/x/119');
  });

  it('stops notifying after unsubscribe', () => {
    const log = new ExchangeLog();
    const fn = vi.fn();
    const off = log.subscribe(fn);
    log.record({ verb: 'GET', path: '/a', status: 200 });
    off();
    log.record({ verb: 'GET', path: '/b', status: 200 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
