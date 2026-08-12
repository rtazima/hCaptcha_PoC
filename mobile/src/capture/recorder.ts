/**
 * Coletor de eventos comportamentais.
 *
 * Privacidade por construção: nada aqui guarda *conteúdo*. Teclas viram classe
 * (`char`/`space`/`backspace`/`enter`) + instante; toques viram coordenada
 * normalizada + duração. O texto digitado nunca sai do TextInput.
 *
 * O cálculo de features é feito no servidor a partir destes eventos crus —
 * assim a lógica de biometria fica versionada num só lugar.
 */
import type {
  DeviceInfo,
  GestureEvent,
  KeyClass,
  KeystrokeEvent,
  MotionSample,
  RawSample,
  StrokePoint,
  TapEvent,
} from '../api/contract';

export interface CaptureCounts {
  keystrokes: number;
  taps: number;
  gestures: number;
  motion: number;
  elapsedMs: number;
}

/** Limites mínimos para o servidor aceitar a amostra (espelham GROUP_MINIMUMS). */
export const CAPTURE_MINIMUMS = {
  keystrokes: 8,
  taps: 3,
  gestures: 3,
  motion: 20,
  durationMs: 1500,
} as const;

const MAX_EVENTS = 3000;
const MAX_POINTS_PER_GESTURE = 600;

export class CaptureRecorder {
  private startedAt = Date.now();
  private keystrokes: KeystrokeEvent[] = [];
  private taps: TapEvent[] = [];
  private gestures: GestureEvent[] = [];
  private motion: MotionSample[] = [];
  private firstInteractionMs: number | null = null;
  private journey: string[] = [];
  /** teclas inseridas de uma vez (colagem/autocompletar) distorcem o ritmo */
  private pasteEvents = 0;

  reset(): void {
    this.startedAt = Date.now();
    this.keystrokes = [];
    this.taps = [];
    this.gestures = [];
    this.motion = [];
    this.firstInteractionMs = null;
    this.journey = [];
    this.pasteEvents = 0;
  }

  /** ms desde o início da captura. */
  now(): number {
    return Date.now() - this.startedAt;
  }

  private markInteraction(at: number): void {
    if (this.firstInteractionMs === null) this.firstInteractionMs = at;
  }

  noteKeystroke(cls: KeyClass, at = this.now()): void {
    if (this.keystrokes.length >= MAX_EVENTS) return;
    this.markInteraction(at);
    this.keystrokes.push({ t: Math.round(at), cls });
  }

  notePaste(): void {
    this.pasteEvents += 1;
  }

  noteTap(x: number, y: number, dwellMs: number, at = this.now()): void {
    if (this.taps.length >= MAX_EVENTS) return;
    this.markInteraction(at);
    this.taps.push({
      t: Math.round(at),
      dt: Math.round(Math.max(0, dwellMs)),
      x: clampUnit(x),
      y: clampUnit(y),
    });
  }

  noteGesture(points: StrokePoint[]): void {
    if (this.gestures.length >= 400 || points.length < 3) return;
    this.markInteraction(points[0].t);
    const trimmed =
      points.length <= MAX_POINTS_PER_GESTURE
        ? points
        : points.filter(
            (_, i) => i % Math.ceil(points.length / MAX_POINTS_PER_GESTURE) === 0,
          );
    this.gestures.push({
      points: trimmed.map((p) => ({
        t: Math.round(p.t),
        x: clampUnit(p.x),
        y: clampUnit(p.y),
      })),
    });
  }

  noteMotion(sample: Omit<MotionSample, 't'>, at = this.now()): void {
    if (this.motion.length >= MAX_EVENTS) return;
    this.motion.push({
      t: Math.round(at),
      ax: round(sample.ax),
      ay: round(sample.ay),
      az: round(sample.az),
      gx: round(sample.gx),
      gy: round(sample.gy),
      gz: round(sample.gz),
    });
  }

  noteScreen(name: string): void {
    if (this.journey[this.journey.length - 1] === name) return;
    if (this.journey.length >= 100) return;
    this.journey.push(name);
  }

  counts(): CaptureCounts {
    return {
      keystrokes: this.keystrokes.length,
      taps: this.taps.length,
      gestures: this.gestures.length,
      motion: this.motion.length,
      elapsedMs: this.now(),
    };
  }

  get pasteCount(): number {
    return this.pasteEvents;
  }

/**
   * true quando a captura já atende aos mínimos que o servidor exige.
   *
   * Movimento é exigido **apenas se a plataforma estiver entregando amostras**.
   * Sem essa ressalva o app travaria onde não há acelerômetro acessível — no
   * Safari do iOS, por exemplo, que só libera sensores após permissão explícita.
   * O servidor concorda: sem o grupo `motion` a cobertura cai de 1.0 para 0.79,
   * ainda acima do mínimo, e o template usa 4 dos 5 grupos.
   */
  isComplete(): boolean {
    const c = this.counts();
    const motionOk = c.motion === 0 || c.motion >= CAPTURE_MINIMUMS.motion;
    return (
      c.keystrokes >= CAPTURE_MINIMUMS.keystrokes &&
      c.taps >= CAPTURE_MINIMUMS.taps &&
      c.gestures >= CAPTURE_MINIMUMS.gestures &&
      motionOk &&
      c.elapsedMs >= CAPTURE_MINIMUMS.durationMs
    );
  }

  snapshot(sessionId: string, task: string, device: DeviceInfo): RawSample {
    return {
      sessionId,
      task,
      device,
      keystrokes: [...this.keystrokes],
      taps: [...this.taps],
      gestures: this.gestures.map((g) => ({ points: [...g.points] })),
      motion: [...this.motion],
      timings: {
        durationMs: Math.round(this.now()),
        firstInteractionMs:
          this.firstInteractionMs === null ? null : Math.round(this.firstInteractionMs),
      },
      journey: [...this.journey],
    };
  }
}

/** Classifica a tecla sem nunca registrar o caractere. */
export function classifyKey(key: string): KeyClass {
  if (key === 'Backspace') return 'backspace';
  if (key === 'Enter') return 'enter';
  if (key === ' ') return 'space';
  return 'char';
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.min(1, Math.max(0, value)).toFixed(5));
}

function round(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(5)) : 0;
}
