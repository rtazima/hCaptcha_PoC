/**
 * Testes específicos do JsonStore — o que depende do formato em arquivo.
 * O comportamento comum às duas implementações está em `store-contract.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonStore, hashToken } from '../src/db/json.js';
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

describe('modo memória', () => {
  it('não escreve em disco e se identifica como "memory"', async () => {
    const store = new JsonStore(null);
    expect(store.kind).toBe('memory');
    await store.ensureUser('u1');
    expect(await store.listUsers()).toHaveLength(1);
  });
});

describe('formato em disco', () => {
  it('guarda apenas o hash do token, nunca o token em claro', async () => {
    const file = tempFile();
    const store = new JsonStore(file);
    await store.markTokenUsed('token-secreto-do-hcaptcha');

    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('token-secreto-do-hcaptcha');
    expect(raw).toContain(hashToken('token-secreto-do-hcaptcha'));
  });

  it('sobrevive a reinício do processo', async () => {
    const file = tempFile();
    const primeira = new JsonStore(file);
    expect(primeira.kind).toBe('json');
    await primeira.ensureUser('u1', 'Ana');
    await primeira.addSample('u1', { task: 't', vector: vector(1), quality });
    await primeira.setTemplate('u1', buildTemplate([vector(1), vector(1.2)]));
    await primeira.appendEvent({
      kind: 'verify',
      userId: 'u1',
      decision: 'allow',
      similarity: 0.9,
      risk: 0.1,
      reasons: ['biometric_match'],
    });

    const segunda = new JsonStore(file);
    const user = (await segunda.getUser('u1'))!;
    expect(user.displayName).toBe('Ana');
    expect(user.samples).toHaveLength(1);
    expect(await segunda.gallery()).toHaveLength(1);
    expect((await segunda.listEvents(10))[0].decision).toBe('allow');
  });

  it('descarta amostras e templates de outra versão de features', async () => {
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
              {
                sampleId: 's1',
                createdAt: '2020-01-01T00:00:00.000Z',
                task: 't',
                quality,
                vector: { version: 999, values: [] },
              },
            ],
            template: {
              version: 999,
              centroid: [],
              spread: [],
              support: [],
              samples: 3,
              builtAt: '2020-01-01T00:00:00.000Z',
            },
          },
        ],
        sessions: [],
        usedTokens: [],
        events: [],
      }),
      'utf8',
    );

    const store = new JsonStore(file);
    const user = (await store.getUser('u1'))!;
    expect(user.samples).toEqual([]);
    expect(user.template).toBeNull();
    expect(await store.gallery()).toEqual([]);
  });

  it('falha com mensagem clara em arquivo corrompido', () => {
    const file = tempFile();
    writeFileSync(file, '{ isto não é json', 'utf8');
    expect(() => new JsonStore(file)).toThrow(/Apague o arquivo/);
  });

  it('começa vazio quando o arquivo ainda não existe', async () => {
    const store = new JsonStore(tempFile());
    expect(await store.listUsers()).toEqual([]);
  });

  it('reset limpa o arquivo, não só a memória', async () => {
    const file = tempFile();
    const store = new JsonStore(file);
    await store.ensureUser('u1');
    await store.addSample('u1', { task: 't', vector: vector(1), quality });
    await store.reset();

    expect(await store.listUsers()).toEqual([]);
    expect(await new JsonStore(file).listUsers()).toEqual([]);
  });

  it('mantém o cache de estatística enquanto o corpus não muda', async () => {
    const store = new JsonStore(null);
    await store.ensureUser('u1');
    await store.addSample('u1', { task: 't', vector: vector(1), quality });
    const antes = await store.corpusStats();
    expect(await store.corpusStats()).toBe(antes); // mesma referência: cache ativo

    await store.addSample('u1', { task: 't2', vector: vector(5), quality });
    expect(await store.corpusStats()).not.toBe(antes);
  });
});
