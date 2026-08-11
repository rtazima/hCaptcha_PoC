/**
 * Construção do template biométrico (o "cadastro").
 *
 * O template é um centróide robusto por dimensão (mediana) acompanhado da
 * dispersão pessoal (MAD escalado) e do nº de amostras que sustentam cada
 * dimensão. Mediana/MAD em vez de média/desvio porque com 5 amostras uma única
 * captura ruim distorceria a média.
 */
import { FEATURE_COUNT, FEATURE_VERSION, type FeatureVector, robustSpread } from './features.js';
import { median } from './stats.js';

export interface BiometricTemplate {
  version: number;
  /** centróide por dimensão (null = dimensão nunca observada) */
  centroid: Array<number | null>;
  /** dispersão pessoal por dimensão */
  spread: Array<number | null>;
  /** nº de amostras que sustentam cada dimensão */
  support: number[];
  /** nº de amostras usadas no template */
  samples: number;
  builtAt: string;
}

export function buildTemplate(vectors: FeatureVector[], now = new Date()): BiometricTemplate {
  const usable = vectors.filter((v) => v.version === FEATURE_VERSION);
  const centroid: Array<number | null> = new Array(FEATURE_COUNT).fill(null);
  const spread: Array<number | null> = new Array(FEATURE_COUNT).fill(null);
  const support: number[] = new Array(FEATURE_COUNT).fill(0);

  for (let i = 0; i < FEATURE_COUNT; i++) {
    const column = usable
      .map((v) => v.values[i])
      .filter((x): x is number => x != null && Number.isFinite(x));
    support[i] = column.length;
    if (column.length === 0) continue;
    centroid[i] = median(column);
    spread[i] = column.length >= 2 ? robustSpread(column) : null;
  }

  return {
    version: FEATURE_VERSION,
    centroid,
    spread,
    support,
    samples: usable.length,
    builtAt: now.toISOString(),
  };
}
