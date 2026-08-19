/**
 * Drives one analysis from submission to result.
 *
 * The playback queue is the only cosmetic thing in here, and it is worth explaining. The heuristic
 * pipeline finishes in well under a second, so the stage events all arrive within a frame or two
 * and the rail flickers from empty to done. Holding each stage on screen for a minimum dwell makes
 * a real sequence legible without pretending the compute was slow: the true figure is reported as
 * `computeMs` on the result, and it is not the sum of these dwells.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Analysis, PipelineEvent, Stage } from '@caliper/core';
import type { SubmitArgs, Transport } from '../transport/types.js';

const MIN_STAGE_DWELL_MS = 240;

export interface AnalysisState {
  analysis: Analysis | null;
  stage: Stage | null;
  progress: number;
  message: string;
  running: boolean;
  error: string | null;
}

const INITIAL: AnalysisState = {
  analysis: null, stage: null, progress: 0, message: '', running: false, error: null,
};

export function useAnalysis(transport: Transport) {
  const [state, setState] = useState<AnalysisState>(INITIAL);
  const queue = useRef<PipelineEvent[]>([]);
  const draining = useRef(false);
  const unsubscribe = useRef<(() => void) | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
    unsubscribe.current?.();
  }, []);

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    while (queue.current.length > 0) {
      const event = queue.current.shift()!;
      if (!mounted.current) break;
      setState((prev) => ({
        ...prev,
        stage: event.stage,
        progress: event.progress,
        message: event.message ?? prev.message,
        running: event.status === 'queued' || event.status === 'running',
        error: event.error ?? null,
      }));
      const terminal = event.status !== 'running' && event.status !== 'queued';
      if (!terminal) await sleep(MIN_STAGE_DWELL_MS);
    }
    draining.current = false;
  }, []);

  const reset = useCallback(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    queue.current = [];
    setState(INITIAL);
  }, []);

  const run = useCallback(
    async (args: SubmitArgs) => {
      unsubscribe.current?.();
      queue.current = [];
      setState({ ...INITIAL, running: true, message: 'Submitting…' });

      try {
        const accepted = await transport.submit(args);

        unsubscribe.current = transport.subscribe(accepted.analysisId, (event) => {
          queue.current.push(event);
          void drain();
        });

        // Poll as well as subscribe. A socket can drop; the terminal state is authoritative in the
        // store, and re-syncing from GET is how a real client recovers rather than hanging.
        const deadline = Date.now() + 120_000;
        for (;;) {
          const analysis = await transport.get(accepted.analysisId);
          if (analysis.status === 'complete' || analysis.status === 'failed' || analysis.status === 'cancelled') {
            // Let the queued stage events finish playing before the result lands, so the rail
            // does not jump straight to done.
            while (queue.current.length > 0 || draining.current) await sleep(60);
            if (!mounted.current) return;
            setState((prev) => ({
              ...prev,
              analysis,
              stage: analysis.stage,
              progress: analysis.progress,
              running: false,
              error: analysis.error ?? null,
            }));
            return;
          }
          if (Date.now() > deadline) throw new Error('Timed out waiting for the assessment.');
          await sleep(200);
        }
      } catch (error) {
        if (!mounted.current) return;
        setState((prev) => ({
          ...prev,
          running: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [transport, drain],
  );

  return { ...state, run, reset };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
