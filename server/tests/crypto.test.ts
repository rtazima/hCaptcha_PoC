import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CryptoConfigError,
  SealedDataError,
  constantTimeEquals,
  createNullSealer,
  createSealer,
  isSealed,
  parseKey,
} from '../src/crypto/atRest.js';
import { JsonStore } from '../src/db/json.js';
import { buildTemplate } from '../src/biometrics/template.js';
import { FEATURE_COUNT, FEATURE_VERSION, type FeatureVector } from '../src/biometrics/features.js';
import type { QualityReport } from '../src/biometrics/contract.js';

const keyB64 = randomBytes(32).toString('base64');
const outraChave = randomBytes(32).toString('base64');

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
  const dir = mkdtempSync(join(tmpdir(), 'hcaptcha-poc-cripto-'));
  tempDirs.push(dir);
  return join(dir, 'db.json');
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('parseKey', () => {
  it('aceita chave de 32 bytes em base64 e em hex', () => {
    expect(parseKey(keyB64)).toHaveLength(32);
    expect(parseKey(randomBytes(32).toString('hex'))).toHaveLength(32);
  });

  it('recusa chave de tamanho errado com instrução de como gerar', () => {
    expect(() => parseKey('curta')).toThrow(CryptoConfigError);
    expect(() => parseKey('curta')).toThrow(/openssl rand -base64 32/);
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('sealer', () => {
  const sealer = createSealer(keyB64);

  it('faz ida e volta preservando o valor', () => {
    const original = { version: 1, values: [1, null, 3.5, -0.25] };
    const sealed = sealer.seal(original);
    expect(sealer.open(sealed)).toEqual(original);
  });

  it('produz saída diferente a cada chamada (IV aleatório)', () => {
    const a = sealer.seal({ x: 1 });
    const b = sealer.seal({ x: 1 });
    expect(a).not.toBe(b);
    expect(sealer.open(a)).toEqual(sealer.open(b));
  });

  it('não deixa o valor legível na saída', () => {
    const sealed = sealer.seal({ segredo: 'ritmo-de-digitacao-do-rodrigo' });
    expect(sealed).not.toContain('ritmo-de-digitacao');
    expect(sealed).not.toContain('segredo');
    expect(isSealed(sealed)).toBe(true);
  });

  it('recusa abrir com a chave errada', () => {
    const sealed = sealer.seal({ x: 1 });
    expect(() => createSealer(outraChave).open(sealed)).toThrow(SealedDataError);
  });

  it('detecta adulteração do ciphertext (GCM autentica)', () => {
    const sealed = sealer.seal({ saldo: 100 });
    const parts = sealed.split('.');
    // vira um bit em um byte real do ciphertext. Mexer no último caractere
    // base64 não serve: os bits de padding são ignorados na decodificação e o
    // resultado pode ser byte a byte idêntico.
    const bytes = Buffer.from(parts[3], 'base64url');
    bytes[0] ^= 0x01;
    parts[3] = bytes.toString('base64url');
    expect(() => sealer.open(parts.join('.'))).toThrow(SealedDataError);
  });

  it('detecta adulteração da tag de autenticação e do IV', () => {
    const sealed = sealer.seal({ saldo: 100 });

    const comTagTrocada = sealed.split('.');
    const tag = Buffer.from(comTagTrocada[2], 'base64url');
    tag[0] ^= 0x01;
    comTagTrocada[2] = tag.toString('base64url');
    expect(() => sealer.open(comTagTrocada.join('.'))).toThrow(SealedDataError);

    const comIvTrocado = sealed.split('.');
    const iv = Buffer.from(comIvTrocado[1], 'base64url');
    iv[0] ^= 0x01;
    comIvTrocado[1] = iv.toString('base64url');
    expect(() => sealer.open(comIvTrocado.join('.'))).toThrow(SealedDataError);
  });

  it('recusa formato desconhecido', () => {
    expect(() => sealer.open('v9.a.b.c')).toThrow(/formato de dado cifrado/);
    expect(() => sealer.open('lixo')).toThrow(SealedDataError);
    expect(isSealed('lixo')).toBe(false);
  });
});

describe('sealer nulo (sem chave)', () => {
  it('fica desabilitado e explica o que fazer se encontrar dado cifrado', () => {
    const nulo = createNullSealer();
    expect(nulo.enabled).toBe(false);
    expect(() => nulo.seal({})).toThrow(CryptoConfigError);
    expect(() => nulo.open('v1.a.b.c')).toThrow(/TEMPLATE_ENCRYPTION_KEY/);
  });

  it('createSealer sem chave devolve o sealer nulo', () => {
    expect(createSealer(null).enabled).toBe(false);
    expect(createSealer('').enabled).toBe(false);
    expect(createSealer('   ').enabled).toBe(false);
  });
});

describe('JsonStore com cifra em repouso', () => {
  async function popular(store: JsonStore) {
    await store.ensureUser('u1', 'Ana');
    await store.addSample('u1', { task: 'enroll-1', vector: vector(1.2345), quality });
    await store.addSample('u1', { task: 'enroll-2', vector: vector(2.3456), quality });
    await store.setTemplate('u1', buildTemplate([vector(1.2345), vector(2.3456)]));
  }

  it('não deixa vetor nem template legíveis no arquivo', async () => {
    const file = tempFile();
    await popular(new JsonStore(file, createSealer(keyB64)));

    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('1.2345');
    expect(raw).not.toContain('2.3456');
    expect(raw).toContain('sealedVector');
    expect(raw).toContain('sealedTemplate');

    const disco = JSON.parse(raw);
    expect(disco.schema).toBe(2);
    expect(disco.encryption).toBe('aes-256-gcm');
    // a estrutura em volta segue inspecionável: dá para auditar sem a chave
    expect(disco.users[0].userId).toBe('u1');
    expect(disco.users[0].displayName).toBe('Ana');
    expect(disco.users[0].samples[0].task).toBe('enroll-1');
    expect(disco.users[0].samples[0].vector).toBeUndefined();
  });

  it('relê os dados com a mesma chave', async () => {
    const file = tempFile();
    await popular(new JsonStore(file, createSealer(keyB64)));

    const reaberto = new JsonStore(file, createSealer(keyB64));
    const user = (await reaberto.getUser('u1'))!;
    expect(user.displayName).toBe('Ana');
    expect(user.samples).toHaveLength(2);
    expect(user.samples[0].vector.values[0]).toBeCloseTo(1.2345, 6);
    expect(await reaberto.gallery()).toHaveLength(1);
    expect(user.template!.centroid[0]).toBeCloseTo((1.2345 + 2.3456) / 2, 6);
  });

  it('falha alto com a chave errada, em vez de devolver base vazia', async () => {
    const file = tempFile();
    await popular(new JsonStore(file, createSealer(keyB64)));
    expect(() => new JsonStore(file, createSealer(outraChave))).toThrow(SealedDataError);
  });

  it('falha com mensagem útil quando a chave desaparece da configuração', async () => {
    const file = tempFile();
    await popular(new JsonStore(file, createSealer(keyB64)));
    expect(() => new JsonStore(file)).toThrow(/TEMPLATE_ENCRYPTION_KEY/);
  });

  it('lê base antiga em claro e a converte ao gravar (migração sem script)', async () => {
    const file = tempFile();
    await popular(new JsonStore(file)); // grava em claro, schema 2 sem cifra
    expect(readFileSync(file, 'utf8')).toContain('1.2345');

    const migrando = new JsonStore(file, createSealer(keyB64));
    expect((await migrando.getUser('u1'))!.samples).toHaveLength(2);

    // qualquer escrita já persiste cifrado
    await migrando.ensureUser('u2', 'Bruno');
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('1.2345');
    expect(raw).toContain('sealedVector');
  });

  it('mantém o arquivo em claro quando não há chave', async () => {
    const file = tempFile();
    await popular(new JsonStore(file));
    const disco = JSON.parse(readFileSync(file, 'utf8'));
    expect(disco.encryption).toBe('none');
    expect(disco.users[0].samples[0].vector.values[0]).toBeCloseTo(1.2345, 6);
  });
});

describe('constantTimeEquals', () => {
  it('compara conteúdo e rejeita tamanhos diferentes', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});
