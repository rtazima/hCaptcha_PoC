/** Utilitários estatísticos robustos usados pelo motor biométrico. */

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** Quantil por interpolação linear. `q` em 0..1. Assume array já ordenado. */
export function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function quantile(xs: number[], q: number): number {
  return quantileSorted([...xs].sort((a, b) => a - b), q);
}

export function median(xs: number[]): number {
  return quantile(xs, 0.5);
}

export function iqr(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
}

/** Desvio absoluto mediano. Multiplique por 1.4826 para estimar sigma. */
export function mad(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

export const MAD_TO_SIGMA = 1.4826;

/** Autocorrelação de lag 1, em -1..1. */
export function autocorr1(xs: number[]): number {
  if (xs.length < 3) return 0;
  const m = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i] - m;
    den += d * d;
    if (i > 0) num += d * (xs[i - 1] - m);
  }
  if (den === 0) return 0;
  return clamp(num / den, -1, 1);
}

/** Entropia de Shannon normalizada (0..1) de um histograma de contagens. */
export function normalizedEntropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0 || counts.length < 2) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * Math.log(p);
  }
  return clamp(h / Math.log(counts.length), 0, 1);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Diferenças entre elementos consecutivos. */
export function diffs(xs: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) out.push(xs[i] - xs[i - 1]);
  return out;
}

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Retorna null se o valor não for finito — features nulas são ignoradas no matching. */
export function safe(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}
