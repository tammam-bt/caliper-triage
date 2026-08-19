/**
 * Colour variegation — the "C" of the ABCD rule.
 *
 * The clinical criterion counts distinct colours present in a lesion. Counting exact colours is
 * meaningless on real pixels, so we cluster in Lab and then ask how many clusters *effectively*
 * carry mass: a lesion that is 98% one brown and 2% scattered noise should score ~1, not ~6.
 * Perplexity — the exponential of the cluster-mass entropy — gives exactly that, continuously.
 */
import type { Lab } from './pixels.js';
import { labDistance } from './pixels.js';

/**
 * Deterministic PRNG. k-means++ needs randomness for seeding, but a triage result that changes
 * between two runs on the same photograph is indefensible, so the randomness is seeded and fixed.
 */
function xorshift(seed: number): () => number {
  let s = seed | 0 || 0x2f6e2b1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 0xffffff) / 0xffffff;
  };
}

export interface ClusterResult {
  centroids: Lab[];
  /** Fraction of points assigned to each centroid. Sums to 1. */
  weights: number[];
  /** Perplexity of `weights` after perceptual merging. 1 = one colour, up to k for k distinct. */
  effectiveCount: number;
}

/**
 * Two centroids closer than this in Lab are the same colour to an eye, so they are merged before
 * counting. Without this step the measure is dominated by sensor noise: k-means happily splits a
 * uniformly brown lesion into six near-identical browns and reports six colours. Delta-E 12 is
 * comfortably above camera noise and comfortably below any clinically meaningful colour change.
 */
export const COLOUR_MERGE_DELTA_E = 12;

/**
 * Single-linkage agglomeration of centroids within `threshold`, summing their masses.
 * Returns the merged mass distribution.
 */
export function mergeNearbyColours(centroids: Lab[], weights: number[], threshold: number): number[] {
  const n = centroids.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (labDistance(centroids[i]!, centroids[j]!) < threshold) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[b] = a;
      }
    }
  }
  const groups = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    groups.set(root, (groups.get(root) ?? 0) + (weights[i] ?? 0));
  }
  return [...groups.values()];
}

export function kmeansLab(points: Lab[], k: number, iterations = 12, seed = 1337): ClusterResult {
  if (points.length === 0) return { centroids: [], weights: [], effectiveCount: 0 };
  const kk = Math.min(k, points.length);
  const rand = xorshift(seed);

  // k-means++ seeding: first centre at random, each subsequent one biased toward distant points.
  const centroids: Lab[] = [points[Math.floor(rand() * points.length)]!];
  while (centroids.length < kk) {
    const d2 = points.map((p) => {
      let best = Infinity;
      for (const c of centroids) best = Math.min(best, labDistance(p, c) ** 2);
      return best;
    });
    const total = d2.reduce((a, b) => a + b, 0);
    if (total <= 0) break;
    let target = rand() * total;
    let idx = 0;
    for (let i = 0; i < d2.length; i++) {
      target -= d2[i]!;
      if (target <= 0) { idx = i; break; }
    }
    centroids.push(points[idx]!);
  }

  const assign = new Int32Array(points.length);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = labDistance(points[i]!, centroids[c]!);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const s = sums[assign[i]!]!;
      const p = points[i]!;
      s[0]! += p[0]; s[1]! += p[1]; s[2]! += p[2]; s[3]! += 1;
    }
    for (let c = 0; c < centroids.length; c++) {
      const s = sums[c]!;
      if (s[3]! > 0) centroids[c] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!];
    }
    if (!moved && it > 0) break;
  }

  const counts = new Array(centroids.length).fill(0);
  for (let i = 0; i < points.length; i++) counts[assign[i]!]++;
  const weights = counts.map((c) => c / points.length);

  const merged = mergeNearbyColours(centroids, weights, COLOUR_MERGE_DELTA_E);
  let entropy = 0;
  for (const w of merged) if (w > 0) entropy -= w * Math.log(w);

  return { centroids, weights, effectiveCount: Math.exp(entropy) };
}
