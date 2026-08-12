/**
 * Escolha da implementação de persistência.
 *
 * `DATABASE_URL` definido -> Postgres (com migrações aplicadas no boot).
 * Ausente -> arquivo JSON, ou memória pura quando `DATA_FILE=memory`.
 *
 * A escolha é do ambiente, não do código: o resto da aplicação só conhece a
 * interface `Store`.
 */
import type { AppConfig } from '../config.js';
import { CryptoConfigError, SealedDataError, createSealer } from '../crypto/atRest.js';
import { JsonStore } from './json.js';
import { PostgresStore } from './postgres.js';
import type { Store } from './types.js';

export async function createStore(config: AppConfig): Promise<Store> {
  const sealer = createSealer(config.encryptionKey);

  if (config.databaseUrl) {
    const store = new PostgresStore({
      connectionString: config.databaseUrl,
      sealer,
      max: config.pgPoolMax,
    });
    try {
      if (!config.skipBootMigrations) await store.migrate();
      // falha no boot se a chave não abrir o que já está gravado, igual ao
      // JsonStore (que lê tudo no construtor)
      await store.assertReadable();
    } catch (error) {
      await store.close().catch(() => {});
      if (error instanceof CryptoConfigError || error instanceof SealedDataError) throw error;
      throw new Error(
        `não foi possível preparar o Postgres: ${(error as Error).message}. ` +
          'Confira DATABASE_URL e se o banco está acessível.',
      );
    }
    return store;
  }

  if (config.serverless) {
    // falhar aqui é obrigatório: em função serverless o disco é efêmero e cada
    // invocação pode ser outro processo. O JsonStore "funcionaria" — gravaria,
    // responderia 200 e perderia tudo na invocação seguinte. Silencioso e pior
    // que um erro.
    throw new Error(
      'ambiente serverless detectado sem DATABASE_URL. O armazenamento em arquivo ' +
        'não persiste aqui: configure um Postgres (ex.: Neon/Vercel Postgres) e ' +
        'defina DATABASE_URL.',
    );
  }

  return new JsonStore(config.dataFile, sealer);
}

export { JsonStore } from './json.js';
export { PostgresStore } from './postgres.js';
export { hashToken } from './json.js';
export type {
  AuditEvent,
  AuditKind,
  CaptureSession,
  ConsumeSessionResult,
  Store,
  StoredSample,
  UserRecord,
} from './types.js';
