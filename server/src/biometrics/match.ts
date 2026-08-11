/**
 * Comparação template x amostra (1:1) e busca em galeria (1:N).
 *
 * Distância = RMS de z-scores robustos, fundido em nível de *grupo* para que
 * digitação, gestos, toques, movimento e ritmo pesem conforme configurado —
 * independentemente de quantas dimensões cada grupo tem.
 *
 * O sigma efetivo por dimensão mistura a dispersão pessoal (que só é confiável
 * com muitas amostras) com a dispersão populacional, encolhendo para o global
 * quando há pouco suporte. Isso evita que um usuário com 5 capturas muito
 * parecidas produza sigma minúsculo e passe a rejeitar a si mesmo.
 */
import type { MatchBreakdown } from './contract.js';
import {
  FEATURE_COUNT,
  FEATURE_GROUP_OF,
  FEATURE_GROUPS,
  FEATURE_NAMES,
  FEATURE_VERSION,
  type FeatureGroup,
  type FeatureVector,
  GROUP_WEIGHTS,
  type CorpusStats,
} from './features.js';
import type { BiometricTemplate } from './template.js';

export interface MatchParams {
  /** limite do |z| por dimensão (robustez a outliers) */
  zClip: number;
  /** encolhimento: peso equivalente do sigma global em nº de amostras */
  shrinkage: number;
  /** piso do sigma pessoal como fração do sigma global */
  personalFloorRatio: number;
  /** distância que corresponde a similaridade 0.5 */
  calibrationMidpoint: number;
  /** inclinação da logística de calibração */
  calibrationSteepness: number;
  groupWeights: Record<FeatureGroup, number>;
}

/**
 * Calibração default obtida com `npm run simulate` sobre dados sintéticos
 * (o simulador imprime a sugestão a cada execução). Em piloto com gente real,
 * rode a calibração com o corpus coletado e ajuste MATCH_MIDPOINT/MATCH_STEEPNESS:
 * estes números fixam a *escala* dos scores, não a acurácia.
 */
export const DEFAULT_MATCH_PARAMS: MatchParams = {
  zClip: 4,
  shrinkage: 3,
  personalFloorRatio: 0.35,
  calibrationMidpoint: 1.19,
  calibrationSteepness: 0.215,
  groupWeights: GROUP_WEIGHTS,
};

export function similarityFromDistance(distance: number, params: MatchParams): number {
  const z = (distance - params.calibrationMidpoint) / params.calibrationSteepness;
  return 1 / (1 + Math.exp(z));
}

/** Compara uma amostra a um template. Retorna null se nada for comparável. */
export function matchScore(
  template: BiometricTemplate,
  probe: FeatureVector,
  corpus: CorpusStats,
  params: MatchParams = DEFAULT_MATCH_PARAMS,
): MatchBreakdown | null {
  if (template.version !== FEATURE_VERSION || probe.version !== FEATURE_VERSION) return null;

  const perGroupSq = new Map<FeatureGroup, { sum: number; weight: number }>();
  const contributions: Array<{ feature: string; z: number }> = [];
  let compared = 0;

  for (let i = 0; i < FEATURE_COUNT; i++) {
    const mu = template.centroid[i];
    const x = probe.values[i];
    if (mu == null || x == null || !Number.isFinite(x)) continue;

    const globalSigma = corpus.scales[i];
    if (!(globalSigma > 0)) continue;

    const personal = template.spread[i];
    const support = template.support[i] ?? 0;
    // alpha cresce com o suporte: 0 amostras -> só global; muitas -> só pessoal
    const alpha = support >= 2 ? support / (support + params.shrinkage) : 0;
    const personalSigma =
      personal != null && personal > 0
        ? Math.max(personal, globalSigma * params.personalFloorRatio)
        : globalSigma;
    const sigma = Math.sqrt(
      alpha * personalSigma * personalSigma + (1 - alpha) * globalSigma * globalSigma,
    );
    if (!(sigma > 0)) continue;

    let z = (x - mu) / sigma;
    if (z > params.zClip) z = params.zClip;
    if (z < -params.zClip) z = -params.zClip;

    // peso de discriminabilidade: dimensões que variam mais dentro da própria
    // pessoa do que entre pessoas quase não contam
    const featureWeight = corpus.weights[i] ?? 1;
    const group = FEATURE_GROUP_OF[i];
    const acc = perGroupSq.get(group) ?? { sum: 0, weight: 0 };
    acc.sum += featureWeight * z * z;
    acc.weight += featureWeight;
    perGroupSq.set(group, acc);

    contributions.push({ feature: FEATURE_NAMES[i], z: Number(z.toFixed(3)) });
    compared++;
  }

  if (compared === 0) return null;

  const perGroup: Record<string, number | null> = {};
  let weightedSum = 0;
  let weightTotal = 0;
  for (const group of FEATURE_GROUPS) {
    const acc = perGroupSq.get(group);
    if (!acc || acc.weight <= 0) {
      perGroup[group] = null;
      continue;
    }
    const groupDistance = Math.sqrt(acc.sum / acc.weight);
    perGroup[group] = Number(groupDistance.toFixed(4));
    const w = params.groupWeights[group] ?? 0;
    weightedSum += w * groupDistance * groupDistance;
    weightTotal += w;
  }

  if (weightTotal === 0) return null;
  const distance = Math.sqrt(weightedSum / weightTotal);

  contributions.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  return {
    distance: Number(distance.toFixed(4)),
    similarity: Number(similarityFromDistance(distance, params).toFixed(4)),
    perGroup,
    topContributors: contributions.slice(0, 5),
    dimensionsCompared: compared,
  };
}

export interface GalleryEntry {
  userId: string;
  displayName: string | null;
  template: BiometricTemplate;
}

export interface RankedMatch extends GalleryEntry {
  match: MatchBreakdown;
}

/** Ranking 1:N: pontua toda a galeria e ordena por similaridade decrescente. */
export function identify(
  gallery: GalleryEntry[],
  probe: FeatureVector,
  corpus: CorpusStats,
  params: MatchParams = DEFAULT_MATCH_PARAMS,
): RankedMatch[] {
  const scored: RankedMatch[] = [];
  for (const entry of gallery) {
    const match = matchScore(entry.template, probe, corpus, params);
    if (match) scored.push({ ...entry, match });
  }
  scored.sort((a, b) => b.match.similarity - a.match.similarity);
  return scored;
}
