/**
 * Persistência em Postgres, atrás da mesma interface `Store`.
 *
 * Duas coisas ficam melhores aqui do que na versão em arquivo:
 *
 * 1. `consumeSession` é um único UPDATE condicional — atômico de verdade, então
 *    o antirreplay da captura vale mesmo com várias instâncias da API.
 * 2. `markTokenUsed` usa ON CONFLICT DO NOTHING, então duas requisições
 *    concorrentes com o mesmo token não geram erro nem duplicata.
 *
 * A cifra em repouso é a mesma: com chave, grava em `sealed_vector`/
 * `sealed_template`; sem chave, nas colunas em claro. O schema aceita os dois e
 * proíbe as duas formas simultâneas (constraint), para nunca ficar ambíguo.
 */
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  FEATURE_VERSION,
  type CorpusStats,
  type FeatureVector,
  computeCorpusStats,
  emptyCorpusStats,
} from '../biometrics/features.js';
import type { BiometricTemplate } from '../biometrics/template.js';
import type { QualityReport } from '../biometrics/contract.js';
import { type Sealer, createNullSealer } from '../crypto/atRest.js';
import { hashToken } from './json.js';
import { migrate } from './migrate.js';
import {
  type AuditEvent,
  type AuditKind,
  type CaptureSession,
  type ConsumeSessionResult,
  MAX_EVENTS,
  MAX_TOKENS,
  type Store,
  type StoredSample,
  type UserRecord,
} from './types.js';

interface UserRow {
  user_id: string;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
  template: BiometricTemplate | null;
  sealed_template: string | null;
}

interface SampleRow {
  sample_id: string;
  user_id: string;
  created_at: Date;
  task: string;
  quality: QualityReport;
  vector: FeatureVector | null;
  sealed_vector: string | null;
}

interface SessionRow {
  session_id: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

interface EventRow {
  event_id: string;
  at: Date;
  kind: string;
  user_id: string | null;
  decision: string | null;
  similarity: string | number | null;
  risk: string | number | null;
  reasons: string[];
  detail: Record<string, unknown> | null;
}

const iso = (value: Date): string => value.toISOString();
/** `double precision` volta como number no driver, mas numeric volta string */
const num = (value: string | number | null): number | null =>
  value == null ? null : typeof value === 'number' ? value : Number(value);

export interface PostgresStoreOptions {
  connectionString: string;
  sealer?: Sealer;
  /** máximo de conexões no pool */
  max?: number;
}

export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  private readonly pool: Pool;
  private readonly sealer: Sealer;
  private statsCache: CorpusStats | null = null;

  constructor(options: PostgresStoreOptions) {
    this.pool = new Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
    this.sealer = options.sealer ?? createNullSealer();
  }

  /** Aplica as migrações pendentes. Idempotente. */
  async migrate(): Promise<void> {
    await migrate(this.pool);
  }

  /**
   * Confere no boot que a chave de cifra configurada abre os dados que já estão
   * no banco.
   *
   * Sem isto, um deploy com a chave errada sobe "saudável" e só falha na
   * primeira leitura — a versão em arquivo falha no boot porque lê tudo no
   * construtor, e as duas precisam se comportar igual.
   */
  async assertReadable(): Promise<void> {
    const { rows } = await this.pool.query<{ sealed_vector: string }>(
      'select sealed_vector from samples where sealed_vector is not null limit 1',
    );
    if (rows.length === 0) return; // nada cifrado gravado: nada a conferir
    // `open` lança CryptoConfigError (sem chave) ou SealedDataError (chave errada)
    this.sealer.open<FeatureVector>(rows[0].sealed_vector);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // -- mapeamento ----------------------------------------------------------

  private toSample(row: SampleRow): StoredSample | null {
    const vector =
      row.sealed_vector != null
        ? this.sealer.open<FeatureVector>(row.sealed_vector)
        : row.vector;
    // amostras de outra versão de features não são comparáveis: descartadas
    if (vector?.version !== FEATURE_VERSION) return null;
    return {
      sampleId: row.sample_id,
      createdAt: iso(row.created_at),
      task: row.task,
      quality: row.quality,
      vector,
    };
  }

  private toTemplate(row: UserRow): BiometricTemplate | null {
    const template =
      row.sealed_template != null
        ? this.sealer.open<BiometricTemplate>(row.sealed_template)
        : row.template;
    return template?.version === FEATURE_VERSION ? template : null;
  }

  private toUser(row: UserRow, sampleRows: SampleRow[]): UserRecord {
    return {
      userId: row.user_id,
      displayName: row.display_name,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      samples: sampleRows
        .map((sample) => this.toSample(sample))
        .filter((sample): sample is StoredSample => sample !== null),
      template: this.toTemplate(row),
    };
  }

  /** Monta os usuários pedidos com suas amostras, sem N+1. */
  private async loadUsers(userIds?: string[]): Promise<UserRecord[]> {
    const users =
      userIds == null
        ? await this.pool.query<UserRow>('select * from users order by created_at, user_id')
        : await this.pool.query<UserRow>(
            'select * from users where user_id = any($1::text[]) order by created_at, user_id',
            [userIds],
          );
    if (users.rowCount === 0) return [];

    const ids = users.rows.map((row) => row.user_id);
    const samples = await this.pool.query<SampleRow>(
      'select * from samples where user_id = any($1::text[]) order by created_at, sample_id',
      [ids],
    );
    const byUser = new Map<string, SampleRow[]>();
    for (const row of samples.rows) {
      const list = byUser.get(row.user_id) ?? [];
      list.push(row);
      byUser.set(row.user_id, list);
    }
    return users.rows.map((row) => this.toUser(row, byUser.get(row.user_id) ?? []));
  }

  // -- ciclo de vida -------------------------------------------------------

  async reset(): Promise<void> {
    // truncate em cascata: samples tem FK para users
    await this.pool.query(
      'truncate users, samples, capture_sessions, used_tokens, audit_events cascade',
    );
    this.statsCache = null;
  }

  // -- sessões de captura --------------------------------------------------

  async createSession(ttlMs: number): Promise<CaptureSession> {
    const { rows } = await this.pool.query<SessionRow>(
      `insert into capture_sessions (session_id, expires_at)
       values ($1, now() + ($2::bigint * interval '1 millisecond'))
       returning *`,
      [randomUUID(), Math.round(ttlMs)],
    );
    const row = rows[0];
    return {
      sessionId: row.session_id,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      consumedAt: null,
    };
  }

  async consumeSession(sessionId: string): Promise<ConsumeSessionResult> {
    if (!isUuid(sessionId)) return { ok: false, reason: 'session_unknown' };

    // um único UPDATE condicional: se duas requisições chegarem juntas, apenas
    // uma afeta linha. É esta atomicidade que a versão em arquivo não tem.
    const updated = await this.pool.query(
      `update capture_sessions
          set consumed_at = now()
        where session_id = $1 and consumed_at is null and expires_at > now()
        returning session_id`,
      [sessionId],
    );
    if (updated.rowCount === 1) return { ok: true };

    // não afetou nada: descobre por quê, para devolver o motivo certo
    const { rows } = await this.pool.query<SessionRow>(
      'select * from capture_sessions where session_id = $1',
      [sessionId],
    );
    if (rows.length === 0) return { ok: false, reason: 'session_unknown' };
    if (rows[0].consumed_at != null) return { ok: false, reason: 'session_already_used' };
    return { ok: false, reason: 'session_expired' };
  }

  // -- tokens hCaptcha -----------------------------------------------------

  async isTokenUsed(token: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'select 1 from used_tokens where token_hash = $1',
      [hashToken(token)],
    );
    return rowCount === 1;
  }

  async markTokenUsed(token: string): Promise<void> {
    await this.pool.query(
      'insert into used_tokens (token_hash) values ($1) on conflict (token_hash) do nothing',
      [hashToken(token)],
    );
    // poda oportunista: mantém a tabela limitada sem job externo
    await this.pool.query(
      `delete from used_tokens
        where token_hash in (
          select token_hash from used_tokens order by seen_at desc offset $1
        )`,
      [MAX_TOKENS],
    );
  }

  // -- usuários ------------------------------------------------------------

  async getUser(userId: string): Promise<UserRecord | undefined> {
    const users = await this.loadUsers([userId]);
    return users[0];
  }

  async listUsers(): Promise<UserRecord[]> {
    return this.loadUsers();
  }

  async ensureUser(userId: string, displayName?: string | null): Promise<UserRecord> {
    await this.pool.query(
      `insert into users (user_id, display_name)
            values ($1, $2)
       on conflict (user_id) do update
            set display_name = coalesce(excluded.display_name, users.display_name),
                updated_at   = case
                                 when excluded.display_name is not null
                                  and excluded.display_name is distinct from users.display_name
                                 then now() else users.updated_at
                               end`,
      [userId, displayName ?? null],
    );
    return (await this.getUser(userId))!;
  }

  async addSample(
    userId: string,
    sample: Omit<StoredSample, 'sampleId' | 'createdAt'>,
  ): Promise<StoredSample> {
    return this.withClient(async (client) => {
      const exists = await client.query('select 1 from users where user_id = $1', [userId]);
      if (exists.rowCount === 0) throw new Error(`usuário desconhecido: ${userId}`);

      const sealed = this.sealer.enabled ? this.sealer.seal(sample.vector) : null;
      const { rows } = await client.query<SampleRow>(
        `insert into samples (sample_id, user_id, task, quality, vector, sealed_vector)
              values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
           returning *`,
        [
          randomUUID(),
          userId,
          sample.task,
          JSON.stringify(sample.quality),
          sealed ? null : JSON.stringify(sample.vector),
          sealed,
        ],
      );
      await client.query('update users set updated_at = now() where user_id = $1', [userId]);
      this.statsCache = null;
      return this.toSample(rows[0])!;
    });
  }

  async trimSamples(userId: string, maxSamples: number): Promise<void> {
    const { rowCount } = await this.pool.query(
      `delete from samples
        where sample_id in (
          select sample_id from samples
           where user_id = $1
           order by created_at desc, sample_id desc
          offset $2
        )`,
      [userId, maxSamples],
    );
    if (rowCount && rowCount > 0) this.statsCache = null;
  }

  async setTemplate(userId: string, template: BiometricTemplate | null): Promise<void> {
    const sealed = template != null && this.sealer.enabled ? this.sealer.seal(template) : null;
    const { rowCount } = await this.pool.query(
      `update users
          set template        = $2::jsonb,
              sealed_template = $3,
              updated_at      = now()
        where user_id = $1`,
      [
        userId,
        template == null || sealed != null ? null : JSON.stringify(template),
        sealed,
      ],
    );
    if (rowCount === 0) throw new Error(`usuário desconhecido: ${userId}`);
  }

  async deleteUser(userId: string): Promise<boolean> {
    return this.withClient(async (client) => {
      // a decisão fica na auditoria, mas desligada da pessoa: o direito à
      // eliminação (LGPD art. 18) não deve exigir apagar a trilha de decisões
      await client.query('update audit_events set user_id = null where user_id = $1', [userId]);
      const { rowCount } = await client.query('delete from users where user_id = $1', [userId]);
      if (rowCount && rowCount > 0) {
        this.statsCache = null;
        return true;
      }
      return false;
    });
  }

  async gallery(): Promise<UserRecord[]> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      'select user_id from users where template is not null or sealed_template is not null',
    );
    if (rows.length === 0) return [];
    const users = await this.loadUsers(rows.map((row) => row.user_id));
    // o filtro final repete a checagem porque um template de versão antiga é
    // descartado na desserialização, mesmo estando presente na coluna
    return users.filter((user) => user.template != null);
  }

  // -- estatística do corpus ----------------------------------------------

  async corpusStats(): Promise<CorpusStats> {
    if (this.statsCache) return this.statsCache;
    const { rows } = await this.pool.query<Pick<SampleRow, 'user_id' | 'vector' | 'sealed_vector'>>(
      'select user_id, vector, sealed_vector from samples',
    );
    const perUser = new Map<string, FeatureVector[]>();
    for (const row of rows) {
      const vector =
        row.sealed_vector != null
          ? this.sealer.open<FeatureVector>(row.sealed_vector)
          : row.vector;
      if (vector?.version !== FEATURE_VERSION) continue;
      const list = perUser.get(row.user_id) ?? [];
      list.push(vector);
      perUser.set(row.user_id, list);
    }
    this.statsCache =
      perUser.size === 0 ? emptyCorpusStats() : computeCorpusStats([...perUser.values()]);
    return this.statsCache;
  }

  // -- auditoria -----------------------------------------------------------

  async appendEvent(event: Omit<AuditEvent, 'eventId' | 'at'>): Promise<AuditEvent> {
    const { rows } = await this.pool.query<EventRow>(
      `insert into audit_events
              (event_id, kind, user_id, decision, similarity, risk, reasons, detail)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
    returning *`,
      [
        randomUUID(),
        event.kind,
        event.userId,
        event.decision,
        event.similarity,
        event.risk,
        JSON.stringify(event.reasons ?? []),
        event.detail == null ? null : JSON.stringify(event.detail),
      ],
    );
    // poda oportunista, mesmo motivo dos tokens
    await this.pool.query(
      `delete from audit_events
        where event_id in (select event_id from audit_events order by at desc offset $1)`,
      [MAX_EVENTS],
    );
    return this.toEvent(rows[0]);
  }

  async listEvents(limit = 50): Promise<AuditEvent[]> {
    const { rows } = await this.pool.query<EventRow>(
      'select * from audit_events order by at desc, event_id desc limit $1',
      [limit],
    );
    return rows.map((row) => this.toEvent(row));
  }

  private toEvent(row: EventRow): AuditEvent {
    const event: AuditEvent = {
      eventId: row.event_id,
      at: iso(row.at),
      kind: row.kind as AuditKind,
      userId: row.user_id,
      decision: row.decision,
      similarity: num(row.similarity),
      risk: num(row.risk),
      reasons: row.reasons ?? [],
    };
    if (row.detail != null) event.detail = row.detail;
    return event;
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
