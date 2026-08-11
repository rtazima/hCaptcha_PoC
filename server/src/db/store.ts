/**
 * Persistência do PoC: JSON em disco (ou memória pura nos testes).
 *
 * Deliberadamente sem banco: a PoC precisa ser inspecionável (`cat data/db.json`)
 * e rodar sem dependência nativa. A interface `Store` é o ponto de troca para
 * Postgres/Redis num piloto — nada acima dela conhece o formato do arquivo.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  FEATURE_VERSION,
  type FeatureVector,
  type CorpusStats,
  computeCorpusStats,
  emptyCorpusStats,
} from '../biometrics/features.js';
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

export interface AuditEvent {
  eventId: string;
  at: string;
  kind: 'enroll' | 'verify' | 'identify' | 'reset';
  userId: string | null;
  decision: string | null;
  similarity: number | null;
  risk: number | null;
  reasons: string[];
  detail?: Record<string, unknown>;
}

interface Snapshot {
  schema: 1;
  featureVersion: number;
  users: UserRecord[];
  sessions: CaptureSession[];
  usedTokens: Array<{ hash: string; at: string }>;
  events: AuditEvent[];
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const MAX_EVENTS = 500;
const MAX_TOKENS = 5000;

export class Store {
  private users = new Map<string, UserRecord>();
  private sessions = new Map<string, CaptureSession>();
  private usedTokens = new Map<string, string>();
  private events: AuditEvent[] = [];
  private statsCache: CorpusStats | null = null;

  constructor(private readonly filePath: string | null = null) {
    if (this.filePath) this.load();
  }

  // -- ciclo de vida -------------------------------------------------------

  private load(): void {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return; // primeira execução
    }
    try {
      const snapshot = JSON.parse(raw) as Snapshot;
      for (const user of snapshot.users ?? []) {
        // amostras de outra versão de features são descartadas (não são comparáveis)
        const samples = (user.samples ?? []).filter((s) => s.vector?.version === FEATURE_VERSION);
        this.users.set(user.userId, {
          ...user,
          samples,
          template: user.template?.version === FEATURE_VERSION ? user.template : null,
        });
      }
      for (const session of snapshot.sessions ?? []) this.sessions.set(session.sessionId, session);
      for (const token of snapshot.usedTokens ?? []) this.usedTokens.set(token.hash, token.at);
      this.events = snapshot.events ?? [];
    } catch (error) {
      throw new Error(
        `Falha ao ler ${this.filePath}: ${(error as Error).message}. ` +
          'Apague o arquivo para começar de zero.',
      );
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const snapshot: Snapshot = {
      schema: 1,
      featureVersion: FEATURE_VERSION,
      users: [...this.users.values()],
      sessions: [...this.sessions.values()].filter(
        (s) => Date.parse(s.expiresAt) > Date.now() - 3_600_000,
      ),
      usedTokens: [...this.usedTokens.entries()]
        .slice(-MAX_TOKENS)
        .map(([hash, at]) => ({ hash, at })),
      events: this.events.slice(-MAX_EVENTS),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  reset(): void {
    this.users.clear();
    this.sessions.clear();
    this.usedTokens.clear();
    this.events = [];
    this.statsCache = null;
    this.persist();
  }

  // -- sessões de captura --------------------------------------------------

  createSession(ttlMs: number): CaptureSession {
    const now = Date.now();
    const session: CaptureSession = {
      sessionId: randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      consumedAt: null,
    };
    this.sessions.set(session.sessionId, session);
    this.persist();
    return session;
  }

  /** Marca a sessão como usada. Retorna o motivo da recusa, ou null se ok. */
  consumeSession(sessionId: string): { ok: true } | { ok: false; reason: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: 'session_unknown' };
    if (session.consumedAt) return { ok: false, reason: 'session_already_used' };
    if (Date.parse(session.expiresAt) < Date.now()) return { ok: false, reason: 'session_expired' };
    session.consumedAt = new Date().toISOString();
    this.persist();
    return { ok: true };
  }

  // -- tokens hCaptcha -----------------------------------------------------

  isTokenUsed(token: string): boolean {
    return this.usedTokens.has(hashToken(token));
  }

  markTokenUsed(token: string): void {
    this.usedTokens.set(hashToken(token), new Date().toISOString());
    this.persist();
  }

  // -- usuários ------------------------------------------------------------

  getUser(userId: string): UserRecord | undefined {
    return this.users.get(userId);
  }

  listUsers(): UserRecord[] {
    return [...this.users.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  ensureUser(userId: string, displayName?: string | null): UserRecord {
    const existing = this.users.get(userId);
    if (existing) {
      if (displayName != null && displayName !== existing.displayName) {
        existing.displayName = displayName;
        existing.updatedAt = new Date().toISOString();
        this.persist();
      }
      return existing;
    }
    const now = new Date().toISOString();
    const created: UserRecord = {
      userId,
      displayName: displayName ?? null,
      createdAt: now,
      updatedAt: now,
      samples: [],
      template: null,
    };
    this.users.set(userId, created);
    this.persist();
    return created;
  }

  addSample(userId: string, sample: Omit<StoredSample, 'sampleId' | 'createdAt'>): StoredSample {
    const user = this.users.get(userId);
    if (!user) throw new Error(`usuário desconhecido: ${userId}`);
    const stored: StoredSample = {
      sampleId: randomUUID(),
      createdAt: new Date().toISOString(),
      ...sample,
    };
    user.samples.push(stored);
    user.updatedAt = stored.createdAt;
    this.statsCache = null;
    this.persist();
    return stored;
  }

  trimSamples(userId: string, maxSamples: number): void {
    const user = this.users.get(userId);
    if (!user || user.samples.length <= maxSamples) return;
    user.samples = user.samples.slice(-maxSamples);
    this.statsCache = null;
    this.persist();
  }

  setTemplate(userId: string, template: BiometricTemplate | null): void {
    const user = this.users.get(userId);
    if (!user) throw new Error(`usuário desconhecido: ${userId}`);
    user.template = template;
    user.updatedAt = new Date().toISOString();
    this.persist();
  }

  deleteUser(userId: string): boolean {
    const removed = this.users.delete(userId);
    if (removed) {
      this.statsCache = null;
      this.persist();
    }
    return removed;
  }

  /** Galeria 1:N: usuários com template pronto. */
  gallery(): UserRecord[] {
    return this.listUsers().filter((u) => u.template != null);
  }

  /**
   * Estatística do corpus (escala + pesos de discriminabilidade), com cache.
   * Agrupada por pessoa porque os pesos comparam variação intra x inter pessoa.
   */
  corpusStats(): CorpusStats {
    if (this.statsCache) return this.statsCache;
    const perUser: FeatureVector[][] = [];
    for (const user of this.users.values()) {
      if (user.samples.length > 0) perUser.push(user.samples.map((s) => s.vector));
    }
    this.statsCache = perUser.length === 0 ? emptyCorpusStats() : computeCorpusStats(perUser);
    return this.statsCache;
  }

  // -- auditoria -----------------------------------------------------------

  appendEvent(event: Omit<AuditEvent, 'eventId' | 'at'>): AuditEvent {
    const stored: AuditEvent = {
      eventId: randomUUID(),
      at: new Date().toISOString(),
      ...event,
    };
    this.events.push(stored);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    this.persist();
    return stored;
  }

  listEvents(limit = 50): AuditEvent[] {
    return this.events.slice(-limit).reverse();
  }
}
