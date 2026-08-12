/**
 * Persistência em arquivo JSON (ou memória pura, quando `filePath` é null).
 *
 * É o default da PoC de propósito: `cat data/db.json` mostra o estado inteiro,
 * não precisa de serviço externo e não tem dependência nativa. Para piloto
 * existe `PostgresStore`, atrás da mesma interface.
 *
 * Limite conhecido: `consumeSession` não é atômico entre processos. Num único
 * processo Node o event loop serializa a leitura-e-escrita, então na PoC o
 * antirreplay funciona; com duas instâncias servindo a mesma pasta, não. Essa é
 * uma das razões para o Postgres num piloto — lá a operação é um único UPDATE
 * condicional.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  FEATURE_VERSION,
  type CorpusStats,
  type FeatureVector,
  computeCorpusStats,
  emptyCorpusStats,
} from '../biometrics/features.js';
import type { BiometricTemplate } from '../biometrics/template.js';
import type { QualityReport } from '../biometrics/contract.js';
import {
  CryptoConfigError,
  SealedDataError,
  type Sealer,
  createNullSealer,
} from '../crypto/atRest.js';
import {
  type AuditEvent,
  type CaptureSession,
  type ConsumeSessionResult,
  MAX_EVENTS,
  MAX_TOKENS,
  type Store,
  type StoredSample,
  type UserRecord,
} from './types.js';

/**
 * Formato em disco. Os campos biométricos podem estar cifrados (`sealedVector`,
 * `sealedTemplate`) — nesse caso os equivalentes em claro estão ausentes.
 * A estrutura em volta segue legível de propósito: dá para ver quem existe e
 * auditar decisões sem ter a chave.
 */
interface DiskSample {
  sampleId: string;
  createdAt: string;
  task: string;
  quality: QualityReport;
  vector?: FeatureVector;
  sealedVector?: string;
}

interface DiskUser {
  userId: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
  samples: DiskSample[];
  template?: BiometricTemplate | null;
  sealedTemplate?: string;
}

interface Snapshot {
  /** 1 = sempre em claro; 2 = campos biométricos podem estar cifrados */
  schema: 1 | 2;
  featureVersion: number;
  encryption?: 'none' | 'aes-256-gcm';
  users: DiskUser[];
  sessions: CaptureSession[];
  usedTokens: Array<{ hash: string; at: string }>;
  events: AuditEvent[];
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class JsonStore implements Store {
  private users = new Map<string, UserRecord>();
  private sessions = new Map<string, CaptureSession>();
  private usedTokens = new Map<string, string>();
  private events: AuditEvent[] = [];
  private statsCache: CorpusStats | null = null;

  readonly kind: 'json' | 'memory';

  constructor(
    private readonly filePath: string | null = null,
    private readonly sealer: Sealer = createNullSealer(),
  ) {
    this.kind = filePath ? 'json' : 'memory';
    if (this.filePath) this.load();
  }

  // -- serialização --------------------------------------------------------

  /** Reconstitui uma amostra do disco, decifrando se necessário. */
  private readSample(sample: DiskSample): StoredSample | null {
    let vector: FeatureVector | undefined = sample.vector;
    if (sample.sealedVector != null) {
      vector = this.sealer.open<FeatureVector>(sample.sealedVector);
    }
    // amostras de outra versão de features não são comparáveis: descartadas
    if (vector?.version !== FEATURE_VERSION) return null;
    return {
      sampleId: sample.sampleId,
      createdAt: sample.createdAt,
      task: sample.task,
      quality: sample.quality,
      vector,
    };
  }

  private readTemplate(user: DiskUser): BiometricTemplate | null {
    const template =
      user.sealedTemplate != null
        ? this.sealer.open<BiometricTemplate>(user.sealedTemplate)
        : user.template;
    return template?.version === FEATURE_VERSION ? template : null;
  }

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
        const samples = (user.samples ?? [])
          .map((sample) => this.readSample(sample))
          .filter((sample): sample is StoredSample => sample !== null);
        this.users.set(user.userId, {
          userId: user.userId,
          displayName: user.displayName,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          samples,
          template: this.readTemplate(user),
        });
      }
      for (const session of snapshot.sessions ?? []) this.sessions.set(session.sessionId, session);
      for (const token of snapshot.usedTokens ?? []) this.usedTokens.set(token.hash, token.at);
      this.events = snapshot.events ?? [];
    } catch (error) {
      // erro de chave/adulteração tem mensagem própria e não deve ser mascarado
      // por um conselho de "apague o arquivo" — apagar seria perder os cadastros
      if (error instanceof CryptoConfigError || error instanceof SealedDataError) throw error;
      throw new Error(
        `Falha ao ler ${this.filePath}: ${(error as Error).message}. ` +
          'Apague o arquivo para começar de zero.',
      );
    }
  }

  private writeUser(user: UserRecord): DiskUser {
    const base = {
      userId: user.userId,
      displayName: user.displayName,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
    if (!this.sealer.enabled) {
      return { ...base, samples: user.samples, template: user.template };
    }
    return {
      ...base,
      samples: user.samples.map((sample) => ({
        sampleId: sample.sampleId,
        createdAt: sample.createdAt,
        task: sample.task,
        quality: sample.quality,
        sealedVector: this.sealer.seal(sample.vector),
      })),
      sealedTemplate: user.template == null ? undefined : this.sealer.seal(user.template),
    };
  }

  private persist(): void {
    if (!this.filePath) return;
    const snapshot: Snapshot = {
      schema: 2,
      featureVersion: FEATURE_VERSION,
      encryption: this.sealer.enabled ? 'aes-256-gcm' : 'none',
      users: [...this.users.values()].map((user) => this.writeUser(user)),
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

  /**
   * Cópia defensiva. O Postgres devolve objetos novos a cada leitura; devolver
   * a referência interna aqui deixaria as duas implementações com semânticas
   * diferentes — e um `push` acidental de quem chama corromperia o estado.
   */
  private static copyUser(user: UserRecord): UserRecord {
    return {
      ...user,
      samples: user.samples.map((sample) => ({ ...sample })),
      template: user.template ? { ...user.template } : null,
    };
  }

  // -- ciclo de vida -------------------------------------------------------

  async reset(): Promise<void> {
    this.users.clear();
    this.sessions.clear();
    this.usedTokens.clear();
    this.events = [];
    this.statsCache = null;
    this.persist();
  }

  async close(): Promise<void> {
    // nada a liberar: escrita é síncrona
  }

  // -- sessões de captura --------------------------------------------------

  async createSession(ttlMs: number): Promise<CaptureSession> {
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

  async consumeSession(sessionId: string): Promise<ConsumeSessionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: 'session_unknown' };
    if (session.consumedAt) return { ok: false, reason: 'session_already_used' };
    if (Date.parse(session.expiresAt) < Date.now()) return { ok: false, reason: 'session_expired' };
    session.consumedAt = new Date().toISOString();
    this.persist();
    return { ok: true };
  }

  // -- tokens hCaptcha -----------------------------------------------------

  async isTokenUsed(token: string): Promise<boolean> {
    return this.usedTokens.has(hashToken(token));
  }

  async markTokenUsed(token: string): Promise<void> {
    this.usedTokens.set(hashToken(token), new Date().toISOString());
    this.persist();
  }

  // -- usuários ------------------------------------------------------------

  async getUser(userId: string): Promise<UserRecord | undefined> {
    const user = this.users.get(userId);
    return user ? JsonStore.copyUser(user) : undefined;
  }

  async listUsers(): Promise<UserRecord[]> {
    return [...this.users.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((user) => JsonStore.copyUser(user));
  }

  async ensureUser(userId: string, displayName?: string | null): Promise<UserRecord> {
    const existing = this.users.get(userId);
    if (existing) {
      if (displayName != null && displayName !== existing.displayName) {
        existing.displayName = displayName;
        existing.updatedAt = new Date().toISOString();
        this.persist();
      }
      return JsonStore.copyUser(existing);
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
    return JsonStore.copyUser(created);
  }

  async addSample(
    userId: string,
    sample: Omit<StoredSample, 'sampleId' | 'createdAt'>,
  ): Promise<StoredSample> {
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
    return { ...stored };
  }

  async trimSamples(userId: string, maxSamples: number): Promise<void> {
    const user = this.users.get(userId);
    if (!user || user.samples.length <= maxSamples) return;
    user.samples = user.samples.slice(-maxSamples);
    this.statsCache = null;
    this.persist();
  }

  async setTemplate(userId: string, template: BiometricTemplate | null): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error(`usuário desconhecido: ${userId}`);
    user.template = template;
    user.updatedAt = new Date().toISOString();
    this.persist();
  }

  async deleteUser(userId: string): Promise<boolean> {
    const removed = this.users.delete(userId);
    if (removed) {
      // a decisão fica na auditoria, mas desligada da pessoa: o direito à
      // eliminação (LGPD art. 18) não deve exigir apagar a trilha de decisões
      for (const event of this.events) {
        if (event.userId === userId) event.userId = null;
      }
      this.statsCache = null;
      this.persist();
    }
    return removed;
  }

  async gallery(): Promise<UserRecord[]> {
    return (await this.listUsers()).filter((u) => u.template != null);
  }

  // -- estatística do corpus ----------------------------------------------

  /**
   * Escala + pesos de discriminabilidade, com cache.
   * Agrupada por pessoa porque os pesos comparam variação intra x inter pessoa.
   */
  async corpusStats(): Promise<CorpusStats> {
    if (this.statsCache) return this.statsCache;
    const perUser: FeatureVector[][] = [];
    for (const user of this.users.values()) {
      if (user.samples.length > 0) perUser.push(user.samples.map((s) => s.vector));
    }
    this.statsCache = perUser.length === 0 ? emptyCorpusStats() : computeCorpusStats(perUser);
    return this.statsCache;
  }

  // -- auditoria -----------------------------------------------------------

  async appendEvent(event: Omit<AuditEvent, 'eventId' | 'at'>): Promise<AuditEvent> {
    const stored: AuditEvent = {
      eventId: randomUUID(),
      at: new Date().toISOString(),
      ...event,
    };
    this.events.push(stored);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    this.persist();
    return { ...stored };
  }

  async listEvents(limit = 50): Promise<AuditEvent[]> {
    return this.events
      .slice(-limit)
      .reverse()
      .map((event) => ({ ...event }));
  }
}
