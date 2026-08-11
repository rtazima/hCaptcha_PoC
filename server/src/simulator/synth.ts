/**
 * Gerador de amostras comportamentais sintéticas.
 *
 * Cada "pessoa" recebe um perfil latente (ritmo de digitação, cinemática de
 * swipe, postura do aparelho, tremor). Cada sessão aplica variação
 * intra-pessoa em cima do perfil — é essa razão entre variação intra-pessoa e
 * inter-pessoa que determina FAR/FRR, então ela é explícita e ajustável.
 *
 * Serve para calibrar e regredir o motor sem depender de coleta em campo.
 * NÃO substitui dados reais: os números que ele produz valem como sanidade de
 * engenharia, não como acurácia de produto.
 */
import type { GestureEvent, KeystrokeEvent, MotionSample, RawSample, TapEvent } from '../biometrics/contract.js';

export interface Rng {
  (): number;
  gauss(): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  pick<T>(items: T[]): T;
}

/** PRNG determinístico (mulberry32) — mesma seed, mesmos números. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = next as Rng;
  rng.gauss = () => {
    // Box-Muller, evitando log(0)
    const u = Math.max(next(), 1e-9);
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.range = (min, max) => min + next() * (max - min);
  rng.int = (min, max) => Math.floor(rng.range(min, max + 1));
  rng.pick = (items) => items[rng.int(0, items.length - 1)];
  return rng;
}

export interface BehaviorProfile {
  id: string;
  /** intervalo médio entre teclas (ms) */
  keyInterval: number;
  /** coef. de variação do ritmo de digitação */
  keyCv: number;
  /** probabilidade de pausa longa entre teclas */
  pauseProb: number;
  /** taxa de backspace */
  backspaceRate: number;
  /** velocidade típica de swipe (telas/s) */
  swipeSpeed: number;
  /** duração típica do swipe (ms) */
  swipeDuration: number;
  /** curvatura lateral do traço (fração do comprimento) */
  swipeCurve: number;
  /** assimetria do perfil de velocidade (1 = min-jerk simétrico) */
  swipeSkew: number;
  /** comprimento típico do swipe (fração da tela) */
  swipeLength: number;
  /** tempo de pressão do toque (ms) */
  tapDwell: number;
  tapDwellCv: number;
  /** postura do aparelho (rad) */
  pitch: number;
  roll: number;
  /** tremor/micromovimento das mãos */
  tremor: number;
  /** latência de reação (ms) */
  reaction: number;
  /** variação intra-pessoa entre sessões (desvio log-normal) */
  sessionSigma: number;
}

/** Perfil humano aleatório. */
export function makeProfile(id: string, rng: Rng): BehaviorProfile {
  return {
    id,
    keyInterval: rng.range(140, 480),
    keyCv: rng.range(0.3, 0.95),
    pauseProb: rng.range(0.02, 0.18),
    backspaceRate: rng.range(0, 0.14),
    swipeSpeed: rng.range(0.5, 2.6),
    swipeDuration: rng.range(180, 620),
    swipeCurve: rng.range(0, 0.22),
    swipeSkew: rng.range(0.75, 1.35),
    swipeLength: rng.range(0.22, 0.62),
    tapDwell: rng.range(55, 190),
    tapDwellCv: rng.range(0.15, 0.6),
    pitch: rng.range(-0.9, -0.1),
    roll: rng.range(-0.35, 0.35),
    tremor: rng.range(0.015, 0.32),
    reaction: rng.range(350, 2200),
    sessionSigma: rng.range(0.08, 0.2),
  };
}

/**
 * Perfil "robô": temporização perfeitamente regular, traços retos, aparelho
 * imóvel. Serve para mostrar que o template comportamental rejeita automação
 * mesmo quando o token do captcha é válido.
 */
export function makeBotProfile(id: string): BehaviorProfile {
  return {
    id,
    keyInterval: 60,
    keyCv: 0.01,
    pauseProb: 0,
    backspaceRate: 0,
    swipeSpeed: 4.5,
    swipeDuration: 90,
    swipeCurve: 0,
    swipeSkew: 1,
    swipeLength: 0.5,
    tapDwell: 30,
    tapDwellCv: 0.01,
    pitch: 0,
    roll: 0,
    tremor: 0.0005,
    reaction: 40,
    sessionSigma: 0.005,
  };
}

/** Aplica variação intra-pessoa multiplicativa. */
function jitter(value: number, sigma: number, rng: Rng): number {
  return value * Math.exp(sigma * rng.gauss());
}

export interface SampleOptions {
  sessionId: string;
  task?: string;
  /** multiplica a variação intra-pessoa (1 = normal, >1 simula dia atípico) */
  variability?: number;
}

/** Gera uma amostra crua plausível para o perfil informado. */
export function generateSample(
  profile: BehaviorProfile,
  rng: Rng,
  options: SampleOptions,
): RawSample {
  const sigma = profile.sessionSigma * (options.variability ?? 1);
  const keyInterval = jitter(profile.keyInterval, sigma, rng);
  const keyCv = jitter(profile.keyCv, sigma * 0.7, rng);
  const swipeSpeed = jitter(profile.swipeSpeed, sigma, rng);
  const swipeDuration = jitter(profile.swipeDuration, sigma, rng);
  const tapDwell = jitter(profile.tapDwell, sigma, rng);
  const tremor = jitter(profile.tremor, sigma * 1.2, rng);
  const pitch = profile.pitch + sigma * 0.6 * rng.gauss();
  const roll = profile.roll + sigma * 0.6 * rng.gauss();

  const firstInteraction = Math.max(80, jitter(profile.reaction, sigma, rng));
  let clock = firstInteraction;

  // ---- digitação ---------------------------------------------------------
  const keystrokes: KeystrokeEvent[] = [];
  const keyCount = rng.int(22, 42);
  for (let i = 0; i < keyCount; i++) {
    let interval = keyInterval * Math.exp(keyCv * rng.gauss() - (keyCv * keyCv) / 2);
    if (rng() < profile.pauseProb) interval *= rng.range(2.5, 6);
    clock += Math.max(25, interval);
    const isBackspace = rng() < profile.backspaceRate;
    keystrokes.push({
      t: Math.round(clock),
      cls: isBackspace ? 'backspace' : rng() < 0.14 ? 'space' : 'char',
    });
  }
  clock += rng.range(200, 800);

  // ---- gestos ------------------------------------------------------------
  const gestures: GestureEvent[] = [];
  const gestureCount = rng.int(4, 7);
  for (let g = 0; g < gestureCount; g++) {
    const duration = Math.max(70, swipeDuration * Math.exp(0.18 * rng.gauss()));
    const length = Math.min(
      0.9,
      Math.max(0.06, profile.swipeLength * Math.exp(0.22 * rng.gauss())),
    );
    // velocidade média almejada define o comprimento efetivo do traço
    const effectiveLength = Math.min(0.95, Math.max(0.06, (swipeSpeed * duration) / 1000));
    const travel = (length + effectiveLength) / 2;

    const angle = rng.range(-Math.PI, Math.PI);
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const perp = { x: -dir.y, y: dir.x };
    const start = { x: rng.range(0.15, 0.85), y: rng.range(0.2, 0.8) };
    const curve = profile.swipeCurve * (rng() < 0.5 ? -1 : 1) * rng.range(0.6, 1.4);

    const points = [];
    const startAt = clock;
    let t = 0;
    while (t <= duration) {
      const tau = Math.min(1, Math.pow(t / duration, profile.swipeSkew));
      // perfil de velocidade min-jerk: posição = 10τ³ - 15τ⁴ + 6τ⁵
      const s = 10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5;
      const lateral = curve * travel * Math.sin(Math.PI * tau);
      points.push({
        t: Math.round(startAt + t),
        x: clampUnit(start.x + dir.x * travel * s + perp.x * lateral + 0.0015 * rng.gauss()),
        y: clampUnit(start.y + dir.y * travel * s + perp.y * lateral + 0.0015 * rng.gauss()),
      });
      t += Math.max(6, 16 + rng.gauss() * 3);
    }
    // garante o ponto final
    points.push({
      t: Math.round(startAt + duration),
      x: clampUnit(start.x + dir.x * travel),
      y: clampUnit(start.y + dir.y * travel),
    });
    gestures.push({ points });
    clock = startAt + duration + Math.max(60, jitter(320, sigma, rng));
  }

  // ---- toques ------------------------------------------------------------
  const taps: TapEvent[] = [];
  const tapCount = rng.int(4, 9);
  for (let i = 0; i < tapCount; i++) {
    const dwell = Math.max(18, tapDwell * Math.exp(profile.tapDwellCv * rng.gauss()));
    taps.push({
      t: Math.round(clock),
      dt: Math.round(dwell),
      x: Number(rng.range(0.1, 0.9).toFixed(4)),
      y: Number(rng.range(0.1, 0.9).toFixed(4)),
    });
    clock += dwell + Math.max(90, jitter(520, sigma, rng));
  }

  const durationMs = Math.round(clock + rng.range(200, 900));

  // ---- movimento do aparelho (20 Hz) -------------------------------------
  const motion: MotionSample[] = [];
  const period = rng.range(2500, 6000);
  for (let t = 0; t <= durationMs; t += 50) {
    const drift = 0.05 * Math.sin((2 * Math.PI * t) / period);
    const p = pitch + drift + tremor * 0.35 * rng.gauss();
    const r = roll + drift * 0.5 + tremor * 0.35 * rng.gauss();
    motion.push({
      t,
      ax: Number((-Math.sin(p) + tremor * 0.12 * rng.gauss()).toFixed(5)),
      ay: Number((Math.sin(r) * Math.cos(p) + tremor * 0.12 * rng.gauss()).toFixed(5)),
      az: Number((Math.cos(r) * Math.cos(p) + tremor * 0.12 * rng.gauss()).toFixed(5)),
      gx: Number((tremor * rng.gauss()).toFixed(5)),
      gy: Number((tremor * rng.gauss()).toFixed(5)),
      gz: Number((tremor * 0.6 * rng.gauss()).toFixed(5)),
    });
  }

  return {
    sessionId: options.sessionId,
    task: options.task ?? 'simulacao',
    device: { os: 'synthetic', osVersion: '1.0', model: 'simulador', screenDiagonal: 6.1 },
    keystrokes,
    taps,
    gestures,
    motion,
    timings: { durationMs, firstInteractionMs: Math.round(firstInteraction) },
    journey: ['Home', 'Captura', 'Resultado'],
  };
}

function clampUnit(x: number): number {
  return Number(Math.min(1, Math.max(0, x)).toFixed(5));
}
