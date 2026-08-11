/**
 * Extração de features comportamentais a partir da amostra crua.
 *
 * A extração roda **no servidor** de propósito: o app só coleta eventos brutos,
 * então a lógica de features é versionada, testada e evoluível num único lugar
 * (e o simulador exercita exatamente o mesmo código do app real).
 *
 * Toda feature pode ser `null` quando não há dados suficientes; o matching
 * compara apenas dimensões presentes nos dois lados.
 */
import type { GestureEvent, QualityReport, RawSample, StrokePoint } from './contract.js';
import {
  MAD_TO_SIGMA,
  autocorr1,
  clamp,
  diffs,
  iqr,
  mean,
  median,
  normalizedEntropy,
  quantile,
  safe,
  std,
} from './stats.js';

export const FEATURE_GROUPS = ['keystroke', 'gesture', 'tap', 'motion', 'session'] as const;
export type FeatureGroup = (typeof FEATURE_GROUPS)[number];

export interface FeatureSpec {
  name: string;
  group: FeatureGroup;
  /** dispersão populacional esperada — bootstrap do scaler global */
  priorScale: number;
  /** descrição curta usada na UI de debug */
  about: string;
}

/**
 * Ordem canônica do vetor de features. Acrescente no fim e suba FEATURE_VERSION:
 * templates gravados com outra versão são invalidados no carregamento.
 */
export const FEATURES: FeatureSpec[] = [
  // -- dinâmica de digitação (keystroke dynamics) ---------------------------
  { name: 'k_count_log', group: 'keystroke', priorScale: 0.5, about: 'log(1+nº de teclas)' },
  { name: 'k_rate', group: 'keystroke', priorScale: 1.2, about: 'teclas por segundo' },
  { name: 'k_ft_mean_log', group: 'keystroke', priorScale: 0.45, about: 'log do tempo médio entre teclas' },
  { name: 'k_ft_median_log', group: 'keystroke', priorScale: 0.45, about: 'log da mediana entre teclas' },
  { name: 'k_ft_std_log', group: 'keystroke', priorScale: 0.6, about: 'log do desvio entre teclas' },
  { name: 'k_ft_iqr_log', group: 'keystroke', priorScale: 0.6, about: 'log do IQR entre teclas' },
  { name: 'k_ft_p90_log', group: 'keystroke', priorScale: 0.55, about: 'log do p90 entre teclas' },
  { name: 'k_ft_cv', group: 'keystroke', priorScale: 0.35, about: 'coef. de variação do ritmo' },
  { name: 'k_ft_min_log', group: 'keystroke', priorScale: 0.5, about: 'log do menor intervalo (dígrafo rápido)' },
  { name: 'k_ft_autocorr1', group: 'keystroke', priorScale: 0.3, about: 'autocorrelação lag-1 do ritmo' },
  { name: 'k_backspace_ratio', group: 'keystroke', priorScale: 0.1, about: 'fração de correções' },
  { name: 'k_pause_ratio', group: 'keystroke', priorScale: 0.12, about: 'fração de pausas > 500ms' },
  { name: 'k_burst_mean_log', group: 'keystroke', priorScale: 0.5, about: 'log do tamanho médio das rajadas' },

  // -- cinemática de gestos (swipe/scroll) ---------------------------------
  { name: 'g_count_log', group: 'gesture', priorScale: 0.45, about: 'log(1+nº de gestos)' },
  { name: 'g_dur_mean_log', group: 'gesture', priorScale: 0.4, about: 'log da duração média do gesto' },
  { name: 'g_dur_cv', group: 'gesture', priorScale: 0.3, about: 'variação da duração do gesto' },
  { name: 'g_path_mean', group: 'gesture', priorScale: 0.16, about: 'comprimento médio do traço (tela=1)' },
  { name: 'g_disp_mean', group: 'gesture', priorScale: 0.15, about: 'deslocamento médio ponta a ponta' },
  { name: 'g_straightness_mean', group: 'gesture', priorScale: 0.09, about: 'retidão (deslocamento/percurso)' },
  { name: 'g_vmean_mean', group: 'gesture', priorScale: 0.55, about: 'velocidade média (tela/s)' },
  { name: 'g_vmax_mean', group: 'gesture', priorScale: 1.0, about: 'velocidade de pico média' },
  { name: 'g_v_ratio', group: 'gesture', priorScale: 0.5, about: 'pico/média (perfil de impulso)' },
  { name: 'g_v_cv', group: 'gesture', priorScale: 0.28, about: 'variação da velocidade no traço' },
  { name: 'g_accel_max_mean', group: 'gesture', priorScale: 4.0, about: 'aceleração de pico média' },
  { name: 'g_jerk_mean_log', group: 'gesture', priorScale: 0.8, about: 'log do jerk médio (suavidade)' },
  { name: 'g_curv_mean', group: 'gesture', priorScale: 0.2, about: 'curvatura média (rad/segmento)' },
  { name: 'g_decel_ratio', group: 'gesture', priorScale: 0.22, about: 'desaceleração no fim do traço' },
  { name: 'g_start_lat_mean_log', group: 'gesture', priorScale: 0.6, about: 'log da latência até iniciar o movimento' },
  { name: 'g_dir_entropy', group: 'gesture', priorScale: 0.22, about: 'entropia das direções' },

  // -- toques (tap dynamics) -----------------------------------------------
  { name: 'p_count_log', group: 'tap', priorScale: 0.45, about: 'log(1+nº de toques)' },
  { name: 'p_dwell_mean_log', group: 'tap', priorScale: 0.4, about: 'log do tempo médio de pressão' },
  { name: 'p_dwell_cv', group: 'tap', priorScale: 0.3, about: 'variação do tempo de pressão' },
  { name: 'p_interval_mean_log', group: 'tap', priorScale: 0.6, about: 'log do intervalo médio entre toques' },

  // -- manuseio do aparelho (acelerômetro/giroscópio) -----------------------
  { name: 'm_acc_dev_mean', group: 'motion', priorScale: 0.05, about: 'desvio médio da gravidade (g)' },
  { name: 'm_acc_dev_std', group: 'motion', priorScale: 0.05, about: 'desvio-padrão do desvio de gravidade' },
  { name: 'm_gyro_mag_mean', group: 'motion', priorScale: 0.12, about: 'magnitude média do giro (rad/s)' },
  { name: 'm_gyro_mag_std', group: 'motion', priorScale: 0.12, about: 'desvio-padrão do giro' },
  { name: 'm_pitch_mean', group: 'motion', priorScale: 0.22, about: 'inclinação média (rad)' },
  { name: 'm_roll_mean', group: 'motion', priorScale: 0.22, about: 'rotação lateral média (rad)' },
  { name: 'm_tilt_std', group: 'motion', priorScale: 0.09, about: 'estabilidade da postura' },
  { name: 'm_stillness', group: 'motion', priorScale: 0.2, about: 'fração de amostras estáveis' },

  // -- ritmo da sessão -----------------------------------------------------
  { name: 's_first_interaction_log', group: 'session', priorScale: 0.7, about: 'log da latência até 1ª interação' },
  { name: 's_duration_log', group: 'session', priorScale: 0.45, about: 'log da duração da captura' },
  { name: 's_event_density', group: 'session', priorScale: 1.5, about: 'eventos por segundo' },
  { name: 's_gesture_share', group: 'session', priorScale: 0.15, about: 'proporção de gestos entre os eventos' },
];

export const FEATURE_VERSION = 1;
export const FEATURE_NAMES: string[] = FEATURES.map((f) => f.name);
export const FEATURE_COUNT = FEATURES.length;
export const FEATURE_INDEX: Record<string, number> = Object.fromEntries(
  FEATURES.map((f, i) => [f.name, i]),
);
export const PRIOR_SCALES: number[] = FEATURES.map((f) => f.priorScale);
export const FEATURE_GROUP_OF: FeatureGroup[] = FEATURES.map((f) => f.group);

/** Peso de cada grupo na distância final (fusão em nível de grupo). */
export const GROUP_WEIGHTS: Record<FeatureGroup, number> = {
  keystroke: 1.0,
  gesture: 1.0,
  tap: 0.6,
  motion: 0.8,
  session: 0.4,
};

/** Dados mínimos para considerar um grupo utilizável. */
export const GROUP_MINIMUMS = {
  keystroke: 8,
  gesture: 3,
  tap: 3,
  motion: 20,
} as const;

/** Vetor de features: valores na ordem de `FEATURES`, com `null` para ausentes. */
export interface FeatureVector {
  version: number;
  values: Array<number | null>;
}

export interface ExtractionResult {
  vector: FeatureVector;
  quality: QualityReport;
}

const log1p = (x: number) => Math.log1p(Math.max(0, x));

interface GestureMetrics {
  duration: number;
  pathLength: number;
  displacement: number;
  straightness: number;
  vMean: number;
  vMax: number;
  vCv: number;
  aMax: number;
  jerk: number;
  curvature: number;
  decelRatio: number;
  startLatency: number;
  directionBin: number;
}

function strokeMetrics(gesture: GestureEvent): GestureMetrics | null {
  const pts = gesture.points
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 3) return null;

  const duration = pts[pts.length - 1].t - pts[0].t;
  if (duration <= 0) return null;

  let pathLength = 0;
  const velocities: number[] = [];
  const vTimes: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const dist = Math.hypot(dx, dy);
    pathLength += dist;
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    if (dt > 0) {
      velocities.push(dist / dt);
      vTimes.push(pts[i].t);
    }
  }
  if (velocities.length < 2) return null;

  const displacement = Math.hypot(
    pts[pts.length - 1].x - pts[0].x,
    pts[pts.length - 1].y - pts[0].y,
  );

  // acelerações e jerk a partir da série de velocidades
  const accels: number[] = [];
  for (let i = 1; i < velocities.length; i++) {
    const dt = (vTimes[i] - vTimes[i - 1]) / 1000;
    if (dt > 0) accels.push((velocities[i] - velocities[i - 1]) / dt);
  }
  const jerks: number[] = [];
  for (let i = 1; i < accels.length; i++) {
    const dt = (vTimes[i + 1] - vTimes[i]) / 1000;
    if (dt > 0) jerks.push(Math.abs((accels[i] - accels[i - 1]) / dt));
  }

  // curvatura: variação angular média entre segmentos consecutivos
  const angleChanges: number[] = [];
  let prevAngle: number | null = null;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    if (Math.hypot(dx, dy) < 1e-4) continue;
    const angle = Math.atan2(dy, dx);
    if (prevAngle !== null) {
      let d = angle - prevAngle;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      angleChanges.push(Math.abs(d));
    }
    prevAngle = angle;
  }

  const vMax = Math.max(...velocities);
  const vMean = mean(velocities);
  const tailStart = Math.max(1, Math.floor(velocities.length * 0.8));
  const tailMean = mean(velocities.slice(tailStart));

  // latência até o movimento sair de um raio de 1% da tela
  let startLatency = duration;
  for (const p of pts) {
    if (Math.hypot(p.x - pts[0].x, p.y - pts[0].y) > 0.01) {
      startLatency = p.t - pts[0].t;
      break;
    }
  }

  const dirAngle = Math.atan2(pts[pts.length - 1].y - pts[0].y, pts[pts.length - 1].x - pts[0].x);
  const directionBin = Math.floor(((dirAngle + Math.PI) / (2 * Math.PI)) * 8) % 8;

  return {
    duration,
    pathLength,
    displacement,
    straightness: pathLength > 0 ? clamp(displacement / pathLength, 0, 1) : 0,
    vMean,
    vMax,
    vCv: vMean > 0 ? std(velocities) / vMean : 0,
    aMax: accels.length ? Math.max(...accels.map(Math.abs)) : 0,
    jerk: jerks.length ? mean(jerks) : 0,
    curvature: angleChanges.length ? mean(angleChanges) : 0,
    decelRatio: vMax > 0 ? clamp(tailMean / vMax, 0, 2) : 0,
    startLatency,
    directionBin,
  };
}

/** Extrai o vetor de features e o laudo de qualidade de uma amostra crua. */
export function extractFeatures(sample: RawSample): ExtractionResult {
  const out = new Map<string, number | null>();
  const set = (name: string, value: number | null) => out.set(name, value);
  const issues: string[] = [];
  const availableGroups: FeatureGroup[] = [];

  const keystrokes = [...(sample.keystrokes ?? [])].sort((a, b) => a.t - b.t);
  const taps = [...(sample.taps ?? [])].sort((a, b) => a.t - b.t);
  const gestures = sample.gestures ?? [];
  const motion = [...(sample.motion ?? [])].sort((a, b) => a.t - b.t);
  const durationMs = Math.max(0, sample.timings?.durationMs ?? 0);

  // ---- keystroke ---------------------------------------------------------
  if (keystrokes.length >= GROUP_MINIMUMS.keystroke) {
    availableGroups.push('keystroke');
    const ft = diffs(keystrokes.map((k) => k.t)).filter((d) => d >= 0 && d < 10_000);
    const ftMean = mean(ft);
    const spanSec = (keystrokes[keystrokes.length - 1].t - keystrokes[0].t) / 1000;

    // rajadas separadas por pausas > 400ms
    const bursts: number[] = [];
    let current = 1;
    for (const d of ft) {
      if (d > 400) {
        bursts.push(current);
        current = 1;
      } else current++;
    }
    bursts.push(current);

    set('k_count_log', log1p(keystrokes.length));
    set('k_rate', spanSec > 0 ? keystrokes.length / spanSec : null);
    set('k_ft_mean_log', log1p(ftMean));
    set('k_ft_median_log', log1p(median(ft)));
    set('k_ft_std_log', log1p(std(ft)));
    set('k_ft_iqr_log', log1p(iqr(ft)));
    set('k_ft_p90_log', log1p(quantile(ft, 0.9)));
    set('k_ft_cv', ftMean > 0 ? std(ft) / ftMean : null);
    set('k_ft_min_log', log1p(Math.min(...ft)));
    set('k_ft_autocorr1', autocorr1(ft));
    set(
      'k_backspace_ratio',
      keystrokes.filter((k) => k.cls === 'backspace').length / keystrokes.length,
    );
    set('k_pause_ratio', ft.length ? ft.filter((d) => d > 500).length / ft.length : null);
    set('k_burst_mean_log', log1p(mean(bursts)));
  } else if (keystrokes.length > 0) {
    issues.push(`digitação insuficiente (${keystrokes.length}/${GROUP_MINIMUMS.keystroke} teclas)`);
  } else {
    issues.push('nenhum evento de digitação capturado');
  }

  // ---- gesture -----------------------------------------------------------
  const metrics = gestures.map(strokeMetrics).filter((m): m is GestureMetrics => m !== null);
  if (metrics.length >= GROUP_MINIMUMS.gesture) {
    availableGroups.push('gesture');
    const durs = metrics.map((m) => m.duration);
    const durMean = mean(durs);
    const dirCounts = new Array(8).fill(0);
    for (const m of metrics) dirCounts[m.directionBin]++;
    const vMeanAvg = mean(metrics.map((m) => m.vMean));

    set('g_count_log', log1p(metrics.length));
    set('g_dur_mean_log', log1p(durMean));
    set('g_dur_cv', durMean > 0 ? std(durs) / durMean : null);
    set('g_path_mean', mean(metrics.map((m) => m.pathLength)));
    set('g_disp_mean', mean(metrics.map((m) => m.displacement)));
    set('g_straightness_mean', mean(metrics.map((m) => m.straightness)));
    set('g_vmean_mean', vMeanAvg);
    set('g_vmax_mean', mean(metrics.map((m) => m.vMax)));
    set('g_v_ratio', vMeanAvg > 0 ? mean(metrics.map((m) => m.vMax)) / vMeanAvg : null);
    set('g_v_cv', mean(metrics.map((m) => m.vCv)));
    set('g_accel_max_mean', mean(metrics.map((m) => m.aMax)));
    set('g_jerk_mean_log', log1p(mean(metrics.map((m) => m.jerk))));
    set('g_curv_mean', mean(metrics.map((m) => m.curvature)));
    set('g_decel_ratio', mean(metrics.map((m) => m.decelRatio)));
    set('g_start_lat_mean_log', log1p(mean(metrics.map((m) => m.startLatency))));
    set('g_dir_entropy', normalizedEntropy(dirCounts));
  } else {
    issues.push(`gestos insuficientes (${metrics.length}/${GROUP_MINIMUMS.gesture} traços válidos)`);
  }

  // ---- tap ---------------------------------------------------------------
  if (taps.length >= GROUP_MINIMUMS.tap) {
    availableGroups.push('tap');
    const dwell = taps.map((t) => Math.max(0, t.dt));
    const dwellMean = mean(dwell);
    const intervals = diffs(taps.map((t) => t.t)).filter((d) => d >= 0);
    set('p_count_log', log1p(taps.length));
    set('p_dwell_mean_log', log1p(dwellMean));
    set('p_dwell_cv', dwellMean > 0 ? std(dwell) / dwellMean : null);
    set('p_interval_mean_log', intervals.length ? log1p(median(intervals)) : null);
  } else {
    issues.push(`toques insuficientes (${taps.length}/${GROUP_MINIMUMS.tap})`);
  }

  // ---- motion ------------------------------------------------------------
  if (motion.length >= GROUP_MINIMUMS.motion) {
    availableGroups.push('motion');
    const accDev = motion.map((m) => Math.abs(Math.hypot(m.ax, m.ay, m.az) - 1));
    const gyroMag = motion.map((m) => Math.hypot(m.gx, m.gy, m.gz));
    const pitch = motion.map((m) => Math.atan2(-m.ax, Math.hypot(m.ay, m.az)));
    const roll = motion.map((m) => Math.atan2(m.ay, m.az));

    set('m_acc_dev_mean', mean(accDev));
    set('m_acc_dev_std', std(accDev));
    set('m_gyro_mag_mean', mean(gyroMag));
    set('m_gyro_mag_std', std(gyroMag));
    set('m_pitch_mean', mean(pitch));
    set('m_roll_mean', mean(roll));
    set('m_tilt_std', (std(pitch) + std(roll)) / 2);
    set('m_stillness', accDev.filter((d) => d < 0.03).length / accDev.length);
  } else {
    issues.push(`amostras de movimento insuficientes (${motion.length}/${GROUP_MINIMUMS.motion})`);
  }

  // ---- session -----------------------------------------------------------
  const eventCount = keystrokes.length + taps.length + metrics.length;
  availableGroups.push('session');
  set(
    's_first_interaction_log',
    sample.timings?.firstInteractionMs != null ? log1p(sample.timings.firstInteractionMs) : null,
  );
  set('s_duration_log', durationMs > 0 ? log1p(durationMs) : null);
  set('s_event_density', durationMs > 0 ? (eventCount * 1000) / durationMs : null);
  set('s_gesture_share', eventCount > 0 ? metrics.length / eventCount : null);

  if (durationMs < 1500) issues.push('captura muito curta (< 1.5s)');

  const values = FEATURES.map((f) => {
    const v = out.get(f.name);
    return v == null ? null : safe(v);
  });

  // qualidade = cobertura ponderada dos grupos disponíveis
  const totalWeight = Object.values(GROUP_WEIGHTS).reduce((a, b) => a + b, 0);
  const gotWeight = availableGroups.reduce((a, g) => a + GROUP_WEIGHTS[g], 0);
  const coverage = gotWeight / totalWeight;
  const hasCore =
    availableGroups.includes('keystroke') || availableGroups.includes('gesture');

  const quality: QualityReport = {
    ok: hasCore && coverage >= 0.5 && durationMs >= 1500,
    score: Number(coverage.toFixed(3)),
    issues,
    counts: {
      keystrokes: keystrokes.length,
      taps: taps.length,
      gestures: metrics.length,
      motion: motion.length,
      durationMs,
    },
    availableGroups,
  };
  if (!hasCore) {
    quality.issues.push('nenhum grupo discriminativo (digitação ou gestos) disponível');
  }

  return { vector: { version: FEATURE_VERSION, values }, quality };
}

/**
 * Estatística do corpus: escala populacional por dimensão + peso de
 * discriminabilidade.
 *
 * O peso é a fração da variância que é *entre pessoas* e não *dentro* da mesma
 * pessoa. Dimensões que variam tanto de uma captura para outra quanto de uma
 * pessoa para outra (ex.: quantidade de eventos, que depende mais da tarefa que
 * do dedo) recebem peso baixo automaticamente, em vez de eu chutar pesos à mão.
 */
export interface CorpusStats {
  version: number;
  /** nº de amostras observadas por dimensão */
  counts: number[];
  /** dispersão populacional por dimensão (denominador do z-score) */
  scales: number[];
  /** dispersão intra-pessoa média (null = sem dados suficientes) */
  within: Array<number | null>;
  /** dispersão entre pessoas (null = sem dados suficientes) */
  between: Array<number | null>;
  /** peso de discriminabilidade 0.05..1 por dimensão */
  weights: number[];
  /** nº de pessoas que sustentam within/between */
  users: number;
}

/** Peso de prior na mistura com a escala observada (em "amostras equivalentes"). */
export const PRIOR_WEIGHT = 10;
/** Mínimo de pessoas com >=2 amostras para estimar discriminabilidade. */
export const MIN_USERS_FOR_WEIGHTS = 4;
/** Piso do peso: nenhuma dimensão é descartada por completo. */
export const MIN_FEATURE_WEIGHT = 0.05;

export function emptyCorpusStats(): CorpusStats {
  return {
    version: FEATURE_VERSION,
    counts: new Array(FEATURE_COUNT).fill(0),
    scales: [...PRIOR_SCALES],
    within: new Array(FEATURE_COUNT).fill(null),
    between: new Array(FEATURE_COUNT).fill(null),
    weights: new Array(FEATURE_COUNT).fill(1),
    users: 0,
  };
}

/**
 * Recalcula escala e pesos a partir do corpus, agrupado por pessoa.
 * Mistura com o prior para permanecer estável com poucos dados.
 */
export function computeCorpusStats(perUser: FeatureVector[][]): CorpusStats {
  const groups = perUser.map((vs) => vs.filter((v) => v.version === FEATURE_VERSION));
  const flat = groups.flat();
  if (flat.length === 0) return emptyCorpusStats();

  const counts = new Array(FEATURE_COUNT).fill(0);
  const scales = new Array(FEATURE_COUNT).fill(0);
  const within: Array<number | null> = new Array(FEATURE_COUNT).fill(null);
  const between: Array<number | null> = new Array(FEATURE_COUNT).fill(null);
  const weights = new Array(FEATURE_COUNT).fill(1);

  const multiSampleUsers = groups.filter((g) => g.length >= 2).length;
  const canWeight = multiSampleUsers >= MIN_USERS_FOR_WEIGHTS;

  for (let i = 0; i < FEATURE_COUNT; i++) {
    const column = flat
      .map((v) => v.values[i])
      .filter((x): x is number => x != null && Number.isFinite(x));
    counts[i] = column.length;

    const observed = column.length >= 4 ? robustSpread(column) : 0;
    const prior = PRIOR_SCALES[i];
    const blended = (PRIOR_WEIGHT * prior + column.length * observed) / (PRIOR_WEIGHT + column.length);
    // nunca deixa a escala colapsar: piso em 25% do prior
    scales[i] = Math.max(blended, prior * 0.25);

    if (!canWeight) continue;

    const perUserSpread: number[] = [];
    const perUserCenter: number[] = [];
    for (const group of groups) {
      const values = group
        .map((v) => v.values[i])
        .filter((x): x is number => x != null && Number.isFinite(x));
      if (values.length >= 2) {
        perUserSpread.push(robustSpread(values));
        perUserCenter.push(median(values));
      }
    }
    if (perUserSpread.length < MIN_USERS_FOR_WEIGHTS) continue;

    const withinSpread = median(perUserSpread);
    const betweenSpread = robustSpread(perUserCenter);
    within[i] = withinSpread;
    between[i] = betweenSpread;

    if (betweenSpread > 0) {
      const ratio = (withinSpread * withinSpread) / (betweenSpread * betweenSpread);
      weights[i] = clamp(1 - ratio, MIN_FEATURE_WEIGHT, 1);
    } else {
      weights[i] = MIN_FEATURE_WEIGHT;
    }
  }

  return {
    version: FEATURE_VERSION,
    counts,
    scales,
    within,
    between,
    weights,
    users: multiSampleUsers,
  };
}

/** Dispersão robusta: MAD escalado, com IQR como reserva quando MAD = 0. */
export function robustSpread(xs: number[]): number {
  const m = median(xs);
  const madValue = median(xs.map((x) => Math.abs(x - m)));
  if (madValue > 0) return madValue * MAD_TO_SIGMA;
  const iqrValue = iqr(xs);
  if (iqrValue > 0) return iqrValue / 1.349;
  return 0;
}
