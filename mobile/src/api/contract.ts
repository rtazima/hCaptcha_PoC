/**
 * Contrato de dados entre app mobile e backend.
 *
 * IMPORTANTE: este arquivo é a fonte da verdade e é copiado para
 * `mobile/src/api/contract.ts` pelo script `npm run sync:contract`
 * (o teste `contract-sync.test.ts` falha se os dois divergirem).
 *
 * Princípio de privacidade: nenhum conteúdo digitado trafega. Teclas são
 * reduzidas a uma *classe* (`char` | `backspace` | `space` | `enter`) e a um
 * timestamp relativo ao início da sessão. Coordenadas de toque são
 * normalizadas (0..1) em relação à tela.
 */

/** Classe da tecla — nunca o caractere em si. */
export type KeyClass = 'char' | 'backspace' | 'space' | 'enter';

export interface KeystrokeEvent {
  /** ms desde o início da sessão de captura */
  t: number;
  cls: KeyClass;
}

export interface TapEvent {
  /** ms desde o início da sessão (touch down) */
  t: number;
  /** duração do toque em ms (down -> up) */
  dt: number;
  /** posição normalizada 0..1 */
  x: number;
  y: number;
}

export interface StrokePoint {
  /** ms desde o início da sessão */
  t: number;
  /** posição normalizada 0..1 */
  x: number;
  y: number;
}

/** Um gesto de arraste/scroll: sequência de pontos entre touch down e up. */
export interface GestureEvent {
  points: StrokePoint[];
}

export interface MotionSample {
  /** ms desde o início da sessão */
  t: number;
  /** aceleração em g (inclui gravidade) */
  ax: number;
  ay: number;
  az: number;
  /** velocidade angular em rad/s */
  gx: number;
  gy: number;
  gz: number;
}

export interface DeviceInfo {
  os: string;
  osVersion?: string;
  model?: string;
  /** diagonal da tela em pontos — usada para sanidade, não para matching */
  screenDiagonal?: number;
}

/** Amostra comportamental crua produzida pelo app. */
export interface RawSample {
  /** id devolvido por POST /v1/sessions/init */
  sessionId: string;
  /** rótulo da tela/tarefa que originou a captura (ex.: "enroll-3") */
  task: string;
  device: DeviceInfo;
  keystrokes: KeystrokeEvent[];
  taps: TapEvent[];
  gestures: GestureEvent[];
  motion: MotionSample[];
  timings: {
    /** duração total da captura em ms */
    durationMs: number;
    /** ms até a primeira interação do usuário */
    firstInteractionMs: number | null;
  };
  /** trilha de navegação (nomes de tela), quando journey tracking está ligado */
  journey?: string[];
}

// ---------------------------------------------------------------------------
// Requests / responses
// ---------------------------------------------------------------------------

export interface SessionInitResponse {
  sessionId: string;
  /** eco do sitekey configurado no backend, para o app não hardcodar */
  sitekey: string;
  /** payload opcional de enterprise a repassar em verifyParams.rqdata */
  rqdata: string | null;
  expiresAt: string;
  captchaMode: 'live' | 'test' | 'mock';
}

export interface EnrollRequest {
  userId: string;
  displayName?: string;
  captchaToken: string;
  sample: RawSample;
}

export interface EnrollResponse {
  userId: string;
  displayName: string | null;
  samplesAccepted: number;
  samplesRequired: number;
  enrolled: boolean;
  quality: QualityReport;
  captcha: CaptchaAssessment;
  /** presente quando a amostra foi rejeitada por qualidade */
  rejected?: { reason: string; details: string[] };
}

export interface VerifyRequest {
  userId: string;
  captchaToken: string;
  sample: RawSample;
}

export interface IdentifyRequest {
  captchaToken: string;
  sample: RawSample;
  /** quantos candidatos retornar no ranking (default 5) */
  topK?: number;
}

export type Decision = 'allow' | 'step_up' | 'deny';

export interface QualityReport {
  ok: boolean;
  score: number;
  issues: string[];
  counts: {
    keystrokes: number;
    taps: number;
    gestures: number;
    motion: number;
    durationMs: number;
  };
  /** grupos de features com dados suficientes nesta amostra */
  availableGroups: string[];
}

export interface CaptchaAssessment {
  success: boolean;
  /** risco 0.0 (sem risco) .. 1.0 (ameaça confirmada) — hCaptcha Enterprise */
  risk: number;
  riskBand: 'low' | 'medium' | 'high';
  /** score_reason do /siteverify (Enterprise) */
  reasons: string[];
  /** true quando o risco foi derivado de success (sitekey não-Enterprise) */
  derived: boolean;
  mode: 'live' | 'test' | 'mock';
  hostname?: string;
  challengeTs?: string;
  errorCodes?: string[];
}

export interface MatchBreakdown {
  /** distância robusta agregada (0 = idêntico) */
  distance: number;
  /** similaridade calibrada 0..1 */
  similarity: number;
  /** distância por grupo de features, para explicabilidade */
  perGroup: Record<string, number | null>;
  /** dimensões que mais contribuíram para a distância */
  topContributors: Array<{ feature: string; z: number }>;
  /** nº de dimensões efetivamente comparadas */
  dimensionsCompared: number;
}

export interface VerifyResponse {
  userId: string;
  decision: Decision;
  reasons: string[];
  match: MatchBreakdown;
  threshold: number;
  quality: QualityReport;
  captcha: CaptchaAssessment;
  latencyMs: number;
}

export interface IdentifyCandidate {
  userId: string;
  displayName: string | null;
  rank: number;
  match: MatchBreakdown;
}

export interface IdentifyResponse {
  decision: Decision;
  reasons: string[];
  /** preenchido quando decision = allow */
  matchedUserId: string | null;
  candidates: IdentifyCandidate[];
  /** diferença de similaridade entre 1º e 2º colocado (rejeição open-set) */
  margin: number | null;
  threshold: number;
  requiredMargin: number;
  quality: QualityReport;
  captcha: CaptchaAssessment;
  latencyMs: number;
}

export interface UserSummary {
  userId: string;
  displayName: string | null;
  samples: number;
  enrolled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
