/**
 * Contrato de persistência.
 *
 * Tudo acima desta interface (serviço, rotas, simulador) não sabe se por baixo
 * há um arquivo JSON ou um Postgres. É o ponto de troca desenhado desde o
 * início da PoC — e é o que permitiu acrescentar Postgres sem tocar no motor
 * biométrico.
 *
 * Os métodos são assíncronos porque um deles precisa ser: banco tem I/O. A
 * implementação em arquivo cumpre o contrato de forma síncrona por dentro.
 */
import type { CorpusStats, FeatureVector } from '../biometrics/features.js';
import type { BiometricTemplate } from '../biometrics/template.js';
import type { QualityReport } from '../biometrics/contract.js';

export interface StoredSample {
  sampleId: string;
  createdAt: string;
  task: string;
  vector: FeatureVector;
  quality: QualityReport;
}

export interface UserRecord {
  userId: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
  samples: StoredSample[];
  template: BiometricTemplate | null;
}

export interface CaptureSession {
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export type AuditKind = 'enroll' | 'verify' | 'identify' | 'reset';

export interface AuditEvent {
  eventId: string;
  at: string;
  kind: AuditKind;
  userId: string | null;
  decision: string | null;
  similarity: number | null;
  risk: number | null;
  reasons: string[];
  detail?: Record<string, unknown>;
}

export type ConsumeSessionResult = { ok: true } | { ok: false; reason: string };

export interface Store {
  // -- sessões de captura --------------------------------------------------
  createSession(ttlMs: number): Promise<CaptureSession>;
  /**
   * Marca a sessão como usada. Precisa ser atômico: duas requisições
   * concorrentes com o mesmo sessionId não podem as duas receber `ok`.
   */
  consumeSession(sessionId: string): Promise<ConsumeSessionResult>;

  // -- tokens do hCaptcha --------------------------------------------------
  isTokenUsed(token: string): Promise<boolean>;
  markTokenUsed(token: string): Promise<void>;

  // -- usuários ------------------------------------------------------------
  getUser(userId: string): Promise<UserRecord | undefined>;
  listUsers(): Promise<UserRecord[]>;
  ensureUser(userId: string, displayName?: string | null): Promise<UserRecord>;
  addSample(
    userId: string,
    sample: Omit<StoredSample, 'sampleId' | 'createdAt'>,
  ): Promise<StoredSample>;
  /** Mantém apenas as `maxSamples` amostras mais recentes. */
  trimSamples(userId: string, maxSamples: number): Promise<void>;
  setTemplate(userId: string, template: BiometricTemplate | null): Promise<void>;
  deleteUser(userId: string): Promise<boolean>;
  /** Galeria 1:N: usuários com template pronto. */
  gallery(): Promise<UserRecord[]>;

  // -- estatística do corpus ----------------------------------------------
  /** Escala e pesos por dimensão, calculados sobre todas as amostras. */
  corpusStats(): Promise<CorpusStats>;

  // -- auditoria -----------------------------------------------------------
  appendEvent(event: Omit<AuditEvent, 'eventId' | 'at'>): Promise<AuditEvent>;
  listEvents(limit?: number): Promise<AuditEvent[]>;

  // -- ciclo de vida -------------------------------------------------------
  reset(): Promise<void>;
  /** Libera conexões. Sem efeito na implementação em arquivo. */
  close(): Promise<void>;
  /** Rótulo para logs e /healthz. */
  readonly kind: 'json' | 'memory' | 'postgres';
}

export const MAX_EVENTS = 500;
export const MAX_TOKENS = 5000;
