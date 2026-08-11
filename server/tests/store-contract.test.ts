/**
 * Suíte de contrato da persistência.
 *
 * A MESMA bateria roda no JsonStore e no PostgresStore. É isso que dá confiança
 * de que trocar `DATABASE_URL` não muda comportamento — e foi assim que apareceu
 * mais de uma divergência sutil entre as duas implementações.
 *
 * Os testes de Postgres são pulados (não falham) quando não há banco: alguém
 * clonando o repo sem Postgres ainda roda a suíte inteira do JSON.
 *   DATABASE_URL_TEST=postgres://hcaptcha_poc:senha@127.0.0.1:5432/hcaptcha_poc_test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonStore } from '../src/db/json.js';
import { PostgresStore } from '../src/db/postgres.js';
import type { Store } from '../src/db/types.js';
import { FEATURE_COUNT, FEATURE_VERSION, type FeatureVector } from '../src/biometrics/features.js';
import { buildTemplate } from '../src/biometrics/template.js';
import { SealedDataError, createSealer } from '../src/crypto/atRest.js';
import type { QualityReport } from '../src/biometrics/contract.js';

const POSTGRES_URL = process.env.DATABASE_URL_TEST;

const quality: QualityReport = {
  ok: true,
  score: 1,
  issues: [],
  counts: { keystrokes: 30, taps: 5, gestures: 5, motion: 100, durationMs: 9000 },
  availableGroups: ['keystroke', 'gesture', 'tap', 'motion', 'session'],
};

function vector(value: number): FeatureVector {
  return { version: FEATURE_VERSION, values: new Array(FEATURE_COUNT).fill(value) };
}

interface Backend {
  name: string;
  /** cria um store limpo; `key` liga a cifra em repouso */
  create(key?: string): Promise<Store>;
  teardown(): Promise<void>;
  skip: boolean;
}

const tempDirs: string[] = [];

const backends: Backend[] = [
  {
    name: 'JsonStore (arquivo)',
    skip: false,
    async create(key) {
      const dir = mkdtempSync(join(tmpdir(), 'poc-contrato-'));
      tempDirs.push(dir);
      return new JsonStore(join(dir, 'db.json'), createSealer(key ?? null));
    },
    async teardown() {
      while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
    },
  },
  {
    name: 'PostgresStore',
    skip: !POSTGRES_URL,
    async create(key) {
      const store = new PostgresStore({
        connectionString: POSTGRES_URL!,
        sealer: createSealer(key ?? null),
      });
      await store.migrate();
      await store.reset(); // isolamento entre testes
      return store;
    },
    async teardown() {},
  },
];

for (const backend of backends) {
  describe.skipIf(backend.skip)(`contrato: ${backend.name}`, () => {
    let store: Store;
    const opened: Store[] = [];

    async function open(key?: string): Promise<Store> {
      const created = await backend.create(key);
      opened.push(created);
      return created;
    }

    beforeEach(async () => {
      store = await open();
    });

    afterEach(async () => {
      while (opened.length) await opened.pop()!.close();
      await backend.teardown();
    });

    afterAll(async () => {
      await backend.teardown();
    });

    // -- sessões -----------------------------------------------------------

    it('consome a sessão exatamente uma vez', async () => {
      const session = await store.createSession(60_000);
      expect(session.consumedAt).toBeNull();
      expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());

      await expect(store.consumeSession(session.sessionId)).resolves.toEqual({ ok: true });
      await expect(store.consumeSession(session.sessionId)).resolves.toEqual({
        ok: false,
        reason: 'session_already_used',
      });
    });

    it('recusa sessão expirada', async () => {
      const expirada = await store.createSession(-1000);
      await expect(store.consumeSession(expirada.sessionId)).resolves.toEqual({
        ok: false,
        reason: 'session_expired',
      });
    });

    it('recusa sessão desconhecida, inclusive com id fora do formato', async () => {
      await expect(
        store.consumeSession('00000000-0000-0000-0000-000000000000'),
      ).resolves.toEqual({ ok: false, reason: 'session_unknown' });
      // um id malformado não pode virar erro de banco
      await expect(store.consumeSession('nao-e-uuid')).resolves.toEqual({
        ok: false,
        reason: 'session_unknown',
      });
    });

    it('não deixa duas requisições concorrentes consumirem a mesma sessão', async () => {
      const session = await store.createSession(60_000);
      const resultados = await Promise.all([
        store.consumeSession(session.sessionId),
        store.consumeSession(session.sessionId),
        store.consumeSession(session.sessionId),
      ]);
      expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    });

    // -- tokens ------------------------------------------------------------

    it('registra token usado e distingue de outro token', async () => {
      await expect(store.isTokenUsed('token-a')).resolves.toBe(false);
      await store.markTokenUsed('token-a');
      await expect(store.isTokenUsed('token-a')).resolves.toBe(true);
      await expect(store.isTokenUsed('token-b')).resolves.toBe(false);
    });

    it('marcar o mesmo token duas vezes não quebra', async () => {
      await store.markTokenUsed('token-repetido');
      await expect(store.markTokenUsed('token-repetido')).resolves.toBeUndefined();
      await expect(store.isTokenUsed('token-repetido')).resolves.toBe(true);
    });

    // -- usuários ----------------------------------------------------------

    it('cria usuário e atualiza o nome de exibição', async () => {
      const criado = await store.ensureUser('u1', 'Ana');
      expect(criado).toMatchObject({ userId: 'u1', displayName: 'Ana', samples: [], template: null });

      await store.ensureUser('u1', 'Ana Maria');
      expect((await store.getUser('u1'))!.displayName).toBe('Ana Maria');

      // ensureUser sem nome não apaga o nome existente
      await store.ensureUser('u1');
      expect((await store.getUser('u1'))!.displayName).toBe('Ana Maria');
    });

    it('devolve undefined para usuário inexistente', async () => {
      await expect(store.getUser('fantasma')).resolves.toBeUndefined();
    });

    it('acumula amostras e as devolve em ordem', async () => {
      await store.ensureUser('u1');
      await store.addSample('u1', { task: 'enroll-1', vector: vector(1), quality });
      await store.addSample('u1', { task: 'enroll-2', vector: vector(2), quality });

      const user = (await store.getUser('u1'))!;
      expect(user.samples).toHaveLength(2);
      expect(user.samples.map((s) => s.task)).toEqual(['enroll-1', 'enroll-2']);
      expect(user.samples[0].vector.values[0]).toBe(1);
      expect(user.samples[0].sampleId).toHaveLength(36);
      expect(await store.listUsers()).toHaveLength(1);
    });

    it('recusa amostra e template para usuário inexistente', async () => {
      await expect(
        store.addSample('fantasma', { task: 't', vector: vector(1), quality }),
      ).rejects.toThrow(/fantasma/);
      await expect(store.setTemplate('fantasma', buildTemplate([vector(1)]))).rejects.toThrow(
        /fantasma/,
      );
    });

    it('mantém apenas as amostras mais recentes ao aparar', async () => {
      await store.ensureUser('u1');
      for (let i = 0; i < 6; i++) {
        await store.addSample('u1', { task: `t-${i}`, vector: vector(i), quality });
      }
      await store.trimSamples('u1', 3);
      expect((await store.getUser('u1'))!.samples.map((s) => s.task)).toEqual([
        't-3',
        't-4',
        't-5',
      ]);
    });

    it('aparar com folga não remove nada', async () => {
      await store.ensureUser('u1');
      await store.addSample('u1', { task: 't', vector: vector(1), quality });
      await store.trimSamples('u1', 10);
      expect((await store.getUser('u1'))!.samples).toHaveLength(1);
    });

    it('só entra na galeria quem tem template', async () => {
      await store.ensureUser('u1');
      await store.addSample('u1', { task: 't', vector: vector(1), quality });
      expect(await store.gallery()).toHaveLength(0);

      await store.setTemplate('u1', buildTemplate([vector(1), vector(1.1)]));
      const galeria = await store.gallery();
      expect(galeria.map((u) => u.userId)).toEqual(['u1']);
      expect(galeria[0].template!.samples).toBe(2);
    });

    it('remover o template tira da galeria', async () => {
      await store.ensureUser('u1');
      await store.setTemplate('u1', buildTemplate([vector(1), vector(1.1)]));
      expect(await store.gallery()).toHaveLength(1);
      await store.setTemplate('u1', null);
      expect(await store.gallery()).toHaveLength(0);
    });

    it('apaga usuário com suas amostras', async () => {
      await store.ensureUser('u1');
      await store.addSample('u1', { task: 't', vector: vector(1), quality });
      await store.setTemplate('u1', buildTemplate([vector(1), vector(2)]));

      await expect(store.deleteUser('u1')).resolves.toBe(true);
      await expect(store.getUser('u1')).resolves.toBeUndefined();
      expect(await store.listUsers()).toEqual([]);
      expect(await store.gallery()).toEqual([]);
      await expect(store.deleteUser('u1')).resolves.toBe(false);
    });

    it('apagar usuário preserva a auditoria, mas desliga da pessoa', async () => {
      await store.ensureUser('u1');
      await store.appendEvent({
        kind: 'verify',
        userId: 'u1',
        decision: 'allow',
        similarity: 0.9,
        risk: 0.1,
        reasons: ['biometric_match'],
      });

      await store.deleteUser('u1');
      const eventos = await store.listEvents(10);
      expect(eventos).toHaveLength(1);
      expect(eventos[0].decision).toBe('allow');
      expect(eventos[0].userId).toBeNull();
    });

    it('devolve cópias: mexer no retorno não corrompe o estado', async () => {
      await store.ensureUser('u1');
      await store.addSample('u1', { task: 't', vector: vector(1), quality });

      const user = (await store.getUser('u1'))!;
      user.samples.push({ ...user.samples[0], sampleId: 'invadido' });
      user.displayName = 'alterado';

      const fresco = (await store.getUser('u1'))!;
      expect(fresco.samples).toHaveLength(1);
      expect(fresco.displayName).toBeNull();
    });

    // -- estatística do corpus --------------------------------------------

    it('estatística acompanha o corpus', async () => {
      const vazia = await store.corpusStats();
      expect(vazia.users).toBe(0);
      expect(vazia.scales.every((s) => s > 0)).toBe(true);

      await store.ensureUser('u1');
      await store.addSample('u1', { task: 't', vector: vector(1), quality });
      await store.addSample('u1', { task: 't2', vector: vector(3), quality });
      await store.ensureUser('u2');
      await store.addSample('u2', { task: 't', vector: vector(10), quality });

      const stats = await store.corpusStats();
      expect(stats.counts[0]).toBe(3);
      expect(stats.version).toBe(FEATURE_VERSION);
    });

    it('estatística é recalculada quando entra amostra nova', async () => {
      await store.ensureUser('u1');
      await store.addSample('u1', { task: 't', vector: vector(1), quality });
      const antes = await store.corpusStats();
      expect(antes.counts[0]).toBe(1);

      await store.addSample('u1', { task: 't2', vector: vector(50), quality });
      const depois = await store.corpusStats();
      expect(depois.counts[0]).toBe(2);
      expect(depois.scales[0]).not.toBe(antes.scales[0]);
    });

    // -- auditoria ---------------------------------------------------------

    it('devolve eventos mais recentes primeiro, com detalhe preservado', async () => {
      for (let i = 0; i < 5; i++) {
        await store.appendEvent({
          kind: 'verify',
          userId: `u${i}`,
          decision: 'allow',
          similarity: 0.9,
          risk: 0.1,
          reasons: ['biometric_match'],
          detail: { indice: i, aninhado: { ok: true } },
        });
      }
      const eventos = await store.listEvents(3);
      expect(eventos).toHaveLength(3);
      expect(eventos.map((e) => e.userId)).toEqual(['u4', 'u3', 'u2']);
      expect(eventos[0].detail).toEqual({ indice: 4, aninhado: { ok: true } });
      expect(eventos[0].reasons).toEqual(['biometric_match']);
      expect(eventos[0].eventId).toHaveLength(36);
    });

    it('aceita evento sem detalhe e com campos nulos', async () => {
      const evento = await store.appendEvent({
        kind: 'identify',
        userId: null,
        decision: 'deny',
        similarity: null,
        risk: null,
        reasons: [],
      });
      expect(evento.detail).toBeUndefined();
      const [lido] = await store.listEvents(1);
      expect(lido).toMatchObject({ kind: 'identify', userId: null, similarity: null, risk: null });
    });

    it('preserva a precisão de similaridade e risco', async () => {
      await store.appendEvent({
        kind: 'verify',
        userId: 'u1',
        decision: 'allow',
        similarity: 0.8735,
        risk: 0.0512,
        reasons: [],
      });
      const [evento] = await store.listEvents(1);
      expect(evento.similarity).toBeCloseTo(0.8735, 6);
      expect(evento.risk).toBeCloseTo(0.0512, 6);
    });

    // -- ciclo de vida -----------------------------------------------------

    it('reset limpa usuários, amostras, tokens e auditoria', async () => {
      await store.ensureUser('u1');
      await store.addSample('u1', { task: 't', vector: vector(1), quality });
      await store.markTokenUsed('token');
      await store.appendEvent({
        kind: 'enroll',
        userId: 'u1',
        decision: 'accepted',
        similarity: null,
        risk: 0.1,
        reasons: [],
      });

      await store.reset();
      expect(await store.listUsers()).toEqual([]);
      expect(await store.listEvents(10)).toEqual([]);
      await expect(store.isTokenUsed('token')).resolves.toBe(false);
      expect((await store.corpusStats()).users).toBe(0);
    });

    // -- cifra em repouso --------------------------------------------------

    it('faz ida e volta dos dados biométricos com cifra ligada', async () => {
      const chave = randomBytes(32).toString('base64');
      const cifrado = await open(chave);
      await cifrado.ensureUser('u1', 'Ana');
      await cifrado.addSample('u1', { task: 't', vector: vector(1.2345), quality });
      await cifrado.setTemplate('u1', buildTemplate([vector(1.2345), vector(2.3456)]));

      const user = (await cifrado.getUser('u1'))!;
      expect(user.samples[0].vector.values[0]).toBeCloseTo(1.2345, 6);
      expect(user.template!.centroid[0]).toBeCloseTo((1.2345 + 2.3456) / 2, 6);
      expect((await cifrado.corpusStats()).counts[0]).toBe(1);
      expect(await cifrado.gallery()).toHaveLength(1);
    });
  });
}

describe('cobertura da suíte de contrato', () => {
  it('avisa quando o Postgres não foi exercitado', () => {
    if (!POSTGRES_URL) {
      console.warn(
        '[contrato] DATABASE_URL_TEST ausente: o PostgresStore NÃO foi testado nesta execução.',
      );
    }
    expect(backends.some((b) => !b.skip)).toBe(true);
  });
});

describe.skipIf(!POSTGRES_URL)('PostgresStore: verificação de chave no boot', () => {
  const chave = randomBytes(32).toString('base64');
  const outraChave = randomBytes(32).toString('base64');

  async function popular(): Promise<void> {
    const store = new PostgresStore({
      connectionString: POSTGRES_URL!,
      sealer: createSealer(chave),
    });
    await store.migrate();
    await store.reset();
    await store.ensureUser('u1');
    await store.addSample('u1', { task: 't', vector: vector(1), quality });
    await store.close();
  }

  async function abrir(key: string | null): Promise<PostgresStore> {
    const store = new PostgresStore({
      connectionString: POSTGRES_URL!,
      sealer: createSealer(key),
    });
    await store.migrate();
    return store;
  }

  it('passa com a chave correta', async () => {
    await popular();
    const store = await abrir(chave);
    await expect(store.assertReadable()).resolves.toBeUndefined();
    await store.close();
  });

  it('falha com a chave errada, sem esperar a primeira leitura', async () => {
    await popular();
    const store = await abrir(outraChave);
    await expect(store.assertReadable()).rejects.toThrow(SealedDataError);
    await store.close();
  });

  it('falha quando a chave desaparece da configuração', async () => {
    await popular();
    const store = await abrir(null);
    await expect(store.assertReadable()).rejects.toThrow(/TEMPLATE_ENCRYPTION_KEY/);
    await store.close();
  });

  it('não reclama de banco vazio', async () => {
    const store = await abrir(chave);
    await store.reset();
    await expect(store.assertReadable()).resolves.toBeUndefined();
    await store.close();
  });
});
