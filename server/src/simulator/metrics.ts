/** Métricas biométricas padrão sobre distribuições de score. */
import { mean, std } from '../biometrics/stats.js';

export interface RocPoint {
  threshold: number;
  /** False Accept Rate: impostores aceitos */
  far: number;
  /** False Reject Rate: genuínos rejeitados */
  frr: number;
}

export interface ScoreMetrics {
  genuine: { n: number; mean: number; std: number; min: number; max: number };
  impostor: { n: number; mean: number; std: number; min: number; max: number };
  /** separação normalizada entre as duas distribuições */
  dPrime: number;
  /** Equal Error Rate e o limiar onde ocorre */
  eer: number;
  eerThreshold: number;
  /** FAR/FRR no limiar operacional configurado */
  atThreshold: RocPoint;
  /** FRR quando FAR <= 1% (limiar mais conservador) */
  frrAtFar1: number | null;
  roc: RocPoint[];
}

function describe(scores: number[]) {
  return {
    n: scores.length,
    mean: Number(mean(scores).toFixed(4)),
    std: Number(std(scores).toFixed(4)),
    min: scores.length ? Number(Math.min(...scores).toFixed(4)) : 0,
    max: scores.length ? Number(Math.max(...scores).toFixed(4)) : 0,
  };
}

function rateAt(genuine: number[], impostor: number[], threshold: number): RocPoint {
  const far = impostor.length ? impostor.filter((s) => s >= threshold).length / impostor.length : 0;
  const frr = genuine.length ? genuine.filter((s) => s < threshold).length / genuine.length : 0;
  return {
    threshold: Number(threshold.toFixed(4)),
    far: Number(far.toFixed(4)),
    frr: Number(frr.toFixed(4)),
  };
}

export function scoreMetrics(
  genuine: number[],
  impostor: number[],
  operatingThreshold: number,
): ScoreMetrics {
  const candidates = [...new Set([...genuine, ...impostor])].sort((a, b) => a - b);
  const roc = candidates.map((t) => rateAt(genuine, impostor, t));

  let eerPoint: RocPoint = { threshold: operatingThreshold, far: 1, frr: 0 };
  let bestGap = Number.POSITIVE_INFINITY;
  for (const point of roc) {
    const gap = Math.abs(point.far - point.frr);
    if (gap < bestGap) {
      bestGap = gap;
      eerPoint = point;
    }
  }

  const far1 = roc.filter((p) => p.far <= 0.01).sort((a, b) => a.frr - b.frr)[0] ?? null;

  const g = describe(genuine);
  const i = describe(impostor);
  const pooled = Math.sqrt((g.std * g.std + i.std * i.std) / 2);

  return {
    genuine: g,
    impostor: i,
    dPrime: pooled > 0 ? Number(((g.mean - i.mean) / pooled).toFixed(3)) : 0,
    eer: Number(((eerPoint.far + eerPoint.frr) / 2).toFixed(4)),
    eerThreshold: eerPoint.threshold,
    atThreshold: rateAt(genuine, impostor, operatingThreshold),
    frrAtFar1: far1 ? far1.frr : null,
    roc,
  };
}

export function pct(x: number | null): string {
  return x == null ? '  n/d' : `${(x * 100).toFixed(2)}%`;
}

/**
 * Sugere a calibração da logística a partir das *distâncias* observadas.
 *
 * O ponto médio vai entre as medianas das duas distribuições e a inclinação é
 * escolhida para que a mediana genuína caia em ~0.9 e a impostora em ~0.1 de
 * similaridade. Assim os limiares da política ficam em torno de 0.5-0.6 e são
 * legíveis, em vez de dependerem de constantes arbitrárias.
 */
export function suggestCalibration(
  genuineDistances: number[],
  impostorDistances: number[],
): { calibrationMidpoint: number; calibrationSteepness: number } | null {
  if (genuineDistances.length < 5 || impostorDistances.length < 5) return null;
  const sortedG = [...genuineDistances].sort((a, b) => a - b);
  const sortedI = [...impostorDistances].sort((a, b) => a - b);
  const medG = sortedG[Math.floor(sortedG.length / 2)];
  const medI = sortedI[Math.floor(sortedI.length / 2)];
  if (!(medI > medG)) return null;
  // ln(0.9/0.1) = 2.197 de cada lado do ponto médio
  const steepness = (medI - medG) / (2 * 2.197);
  return {
    calibrationMidpoint: Number(((medG + medI) / 2).toFixed(3)),
    calibrationSteepness: Number(Math.max(0.02, steepness).toFixed(3)),
  };
}
