import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, hashToken } from '../src/db/store.js';
import { FEATURE_COUNT, FEATURE_VERSION, type FeatureVector } from '../src/biometrics/features.js';
import { buildTemplate } from '../src/biometrics/template.js';
import type { QualityReport } from '../src/biometrics/contract.js';

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

const tempDirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hcaptcha-poc-'));
  tempDirs.push(dir);
  return join(dir, 'db.json');
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('sessões', () => {
  it('consome a sessão apenas uma vez', () => {
    const store = new Store(null);
    const session = store.createSession(60_000);
    expect(store.consumeSession(session.sessionId)).toEqual({ ok: true });
    expect(store.consumeSession(session.sessionId)).toEqual({
      ok: false,
      reason: 'session_already_used',
    });
  });

  it('recusa sessão expirada e desconhecida', () => {
    const store = new Store(null);
    const expirada = store.createSession(-1);
    expect(store.consumeSession(expirada.sessionId)).toEqual({ ok: false, reason: 'session_expired' });
    expect(store.consumeSession('inexistente')).toEqual({ ok: false, reason: 'session_unknown' });
  });
});

describe('tokens', () => {
  it('guarda apenas o hash do token, nunca o token em claro', () => {
    const file = tempFile();
    const store = new Store(file);
    store.markTokenUsed('token-secreto-do-hcaptcha');

    expect(store.isTokenUsed('token-secreto-do-hcaptcha')).toBe(true);
    expect(store.isTokenUsed('outro-token')).toBe(false);

    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('token-secreto-do-hcaptcha');
    expect(raw).toContain(hashToken('token-secreto-do-hcaptcha'));
  });
});

describe('usuários e amostras', () => {
  it('cria, atualiza nome e acumula amostras', () => {
    const store = new Store(null);
    store.ensureUser('u1', 'Ana');
    store.ensureUser('u1', 'Ana Maria');
    expect(store.getUser('u1')!.displayName).toBe('Ana Maria');

    store.addSample('u1', { task: 'enroll-1', vector: vector(1), quality });
    store.addSample('u1', { task: 'enroll-2', vector: vector(2), quality });
    expect(store.getUser('u1')!.samples).toHaveLength(2);
    expect(store.listUsers()).toHaveLength(1);
  });

  it('recusa amostra para usuário inexistente', () => {
    const store = new Store(null);
    expect(() => store.addSample('fantasma', { task: 't', vector: vector(1), quality })).toThrow();
  });

  it('mantém apenas as amostras mais recentes ao aparar', () => {
    const store = new Store(null);
    store.ensureUser('u1');
    for (let i = 0; i < 6; i++) {
      store.addSample('u1', { task: `t-${i}`, vector: vector(i), quality });
    }
    store.trimSamples('u1', 3);
    expect(store.getUser('u1')!.samples.map((s) => s.task)).toEqual(['t-3', 't-4', 't-5']);
  });

  it('só entra na galeria quem tem template', () => {
    const store = new Store(null);
    store.ensureUser('u1');
    store.addSample('u1', { task: 't', vector: vector(1), quality });
    expect(store.gallery()).toHaveLength(0);

    store.setTemplate('u1', buildTemplate([vector(1), vector(1.1)]));
    expect(store.gallery().map((u) => u.userId)).toEqual(['u1']);
  });

  it('invalida o cache de estatística ao mudar o corpus', () => {
    const store = new Store(null);
    store.ensureUser('u1');
    store.addSample('u1', { task: 't', vector: vector(1), quality });
    const antes = store.corpusStats();
    expect(store.corpusStats()).toBe(antes); // mesmo objeto: cache ativo

    store.addSample('u1', { task: 't2', vector: vector(5), quality });
    expect(store.corpusStats()).not.toBe(antes);
  });
});

describe('persistência', () => {
  it('sobrevive a reinício do processo', () => {
    const file = tempFile();
    const primeira = new Store(file);
    primeira.ensureUser('u1', 'Ana');
    primeira.addSample('u1', { task: 't', vector: vector(1), quality });
    primeira.setTemplate('u1', buildTemplate([vector(1), vector(1.2)]));
    primeira.appendEvent({
      kind: 'verify',
      userId: 'u1',
      decision: 'allow',
      similarity: 0.9,
      risk: 0.1,
      reasons: ['biometric_match'],
    });

    const segunda = new Store(file);
    expect(segunda.getUser('u1')!.displayName).toBe('Ana');
    expect(segunda.getUser('u1')!.samples).toHaveLength(1);
    expect(segunda.gallery()).toHaveLength(1);
    expect(segunda.listEvents(10)[0].decision).toBe('allow');
  });

  it('descarta amostras e templates de outra versão de features', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        featureVersion: 999,
        users: [
          {
            userId: 'u1',
            displayName: 'Antiga',
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-01T00:00:00.000Z',
            samples: [
              { sampleId: 's1', createdAt: '2020-01-01T00:00:00.000Z', task: 't', quality, vector: { version: 999, values: [] } },
            ],
            template: { version: 999, centroid: [], spread: [], support: [], samples: 3, builtAt: '2020-01-01T00:00:00.000Z' },
          },
        ],
        sessions: [],
        usedTokens: [],
        events: [],
      }),
      'utf8',
    );

    const store = new Store(file);
    expect(store.getUser('u1')!.samples).toEqual([]);
    expect(store.getUser('u1')!.template).toBeNull();
    expect(store.gallery()).toEqual([]);
  });

  it('falha com mensagem clara em arquivo corrompido', () => {
    const file = tempFile();
    writeFileSync(file, '{ isto não é json', 'utf8');
    expect(() => new Store(file)).toThrow(/Apague o arquivo/);
  });

  it('começa vazio quando o arquivo ainda não existe', () => {
    const store = new Store(tempFile());
    expect(store.listUsers()).toEqual([]);
  });

  it('reset limpa tudo, inclusive em disco', () => {
    const file = tempFile();
    const store = new Store(file);
    store.ensureUser('u1');
    store.addSample('u1', { task: 't', vector: vector(1), quality });
    store.reset();

    expect(store.listUsers()).toEqual([]);
    expect(new Store(file).listUsers()).toEqual([]);
  });
});

describe('auditoria', () => {
  it('devolve os eventos mais recentes primeiro', () => {
    const store = new Store(null);
    for (let i = 0; i < 5; i++) {
      store.appendEvent({
        kind: 'verify',
        userId: `u${i}`,
        decision: 'allow',
        similarity: 0.9,
        risk: 0.1,
        reasons: [],
      });
    }
    const events = store.listEvents(3);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.userId)).toEqual(['u4', 'u3', 'u2']);
  });
});
