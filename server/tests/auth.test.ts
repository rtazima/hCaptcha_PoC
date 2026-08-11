import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JsonStore } from '../src/db/json.js';
import {
  AuthConfigError,
  MIN_KEY_LENGTH,
  buildAuthConfig,
  extractKey,
  hashKey,
  isAuthorized,
} from '../src/auth.js';
import type { Request } from 'express';

const CHAVE = 'chave-de-teste-com-tamanho-ok';
const OUTRA = 'outra-chave-igualmente-longa-x';

function req(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

describe('buildAuthConfig', () => {
  it('fica desligado sem chaves', () => {
    const auth = buildAuthConfig([]);
    expect(auth.enabled).toBe(false);
    expect(auth.keyHashes).toEqual([]);
  });

  it('ignora entradas vazias', () => {
    expect(buildAuthConfig(['', '  ']).enabled).toBe(false);
    expect(buildAuthConfig([CHAVE, '', OUTRA]).keyHashes).toHaveLength(2);
  });

  it('guarda hash, nunca a chave em claro', () => {
    const auth = buildAuthConfig([CHAVE]);
    expect(auth.keyHashes[0]).toBe(hashKey(CHAVE));
    expect(JSON.stringify(auth)).not.toContain(CHAVE);
  });

  it('recusa chave curta com instrução de como gerar', () => {
    expect(() => buildAuthConfig(['curta'])).toThrow(AuthConfigError);
    expect(() => buildAuthConfig(['curta'])).toThrow(/openssl rand -hex 24/);
    expect(() => buildAuthConfig(['x'.repeat(MIN_KEY_LENGTH)])).not.toThrow();
  });
});

describe('extractKey', () => {
  it('lê do header Authorization Bearer, sem diferenciar caixa do esquema', () => {
    expect(extractKey(req({ authorization: `Bearer ${CHAVE}` }))).toBe(CHAVE);
    expect(extractKey(req({ authorization: `bearer ${CHAVE}` }))).toBe(CHAVE);
  });

  it('lê do header x-api-key', () => {
    expect(extractKey(req({ 'x-api-key': CHAVE }))).toBe(CHAVE);
  });

  it('devolve null quando não há chave', () => {
    expect(extractKey(req({}))).toBeNull();
    expect(extractKey(req({ authorization: 'Basic dXNlcjpwYXNz' }))).toBeNull();
    expect(extractKey(req({ 'x-api-key': '   ' }))).toBeNull();
  });
});

describe('isAuthorized', () => {
  it('libera tudo quando a autenticação está desligada', () => {
    const aberto = buildAuthConfig([]);
    expect(isAuthorized(aberto, null)).toBe(true);
    expect(isAuthorized(aberto, 'qualquer-coisa')).toBe(true);
  });

  it('aceita qualquer uma das chaves configuradas', () => {
    const auth = buildAuthConfig([CHAVE, OUTRA]);
    expect(isAuthorized(auth, CHAVE)).toBe(true);
    expect(isAuthorized(auth, OUTRA)).toBe(true);
  });

  it('recusa chave errada, ausente ou com espaço a mais no meio', () => {
    const auth = buildAuthConfig([CHAVE]);
    expect(isAuthorized(auth, null)).toBe(false);
    expect(isAuthorized(auth, 'errada-mas-longa-o-suficiente')).toBe(false);
    expect(isAuthorized(auth, CHAVE.replace('-', ' '))).toBe(false);
  });

  it('tolera espaço em volta (copiar e colar de terminal)', () => {
    expect(isAuthorized(buildAuthConfig([CHAVE]), `  ${CHAVE}  `)).toBe(true);
  });
});

describe('API com autenticação ligada', () => {
  function harness(keys: string) {
    const config = loadConfig({ HCAPTCHA_MODE: 'mock', DATA_FILE: 'memory', API_KEYS: keys });
    return createApp({ config, store: new JsonStore(null) });
  }

  it('/healthz continua aberto e anuncia que há autenticação', async () => {
    const { app } = harness(CHAVE);
    const { body } = await request(app).get('/healthz').expect(200);
    expect(body.ok).toBe(true);
    expect(body.authRequired).toBe(true);
    // o cliente descobre que precisa de chave, nunca qual é
    expect(JSON.stringify(body)).not.toContain(CHAVE);
  });

  it('recusa 401 sem chave', async () => {
    const { app } = harness(CHAVE);
    const { body } = await request(app).get('/v1/users').expect(401);
    expect(body.error).toBe('unauthorized');
    expect(body.message).toMatch(/Authorization/);
  });

  it('recusa 401 com chave errada', async () => {
    const { app } = harness(CHAVE);
    await request(app).get('/v1/users').set('authorization', `Bearer ${OUTRA}`).expect(401);
    await request(app).get('/v1/users').set('x-api-key', OUTRA).expect(401);
  });

  it('libera com a chave certa nos dois headers', async () => {
    const { app } = harness(CHAVE);
    await request(app).get('/v1/users').set('authorization', `Bearer ${CHAVE}`).expect(200);
    await request(app).get('/v1/users').set('x-api-key', CHAVE).expect(200);
  });

  it('protege as rotas de decisão e as administrativas', async () => {
    const { app } = harness(CHAVE);
    await request(app).post('/v1/sessions/init').send({}).expect(401);
    await request(app).post('/v1/verify').send({}).expect(401);
    await request(app).post('/v1/identify').send({}).expect(401);
    await request(app).post('/v1/enroll').send({}).expect(401);
    await request(app).get('/v1/config').expect(401);
    await request(app).get('/v1/audit').expect(401);
    await request(app).post('/v1/admin/reset').send({}).expect(401);
    await request(app).delete('/v1/users/alguem').expect(401);
  });

  it('aceita múltiplas chaves (rotação sem downtime)', async () => {
    const { app } = harness(`${CHAVE},${OUTRA}`);
    await request(app).get('/v1/users').set('x-api-key', CHAVE).expect(200);
    await request(app).get('/v1/users').set('x-api-key', OUTRA).expect(200);
  });

  it('recusa subir com chave curta em vez de aceitar silenciosamente', () => {
    const config = loadConfig({ HCAPTCHA_MODE: 'mock', DATA_FILE: 'memory', API_KEYS: 'abc' });
    expect(() => createApp({ config, store: new JsonStore(null) })).toThrow(AuthConfigError);
  });
});

describe('API sem autenticação (default da PoC)', () => {
  it('segue aberta e diz isso no /healthz', async () => {
    const config = loadConfig({ HCAPTCHA_MODE: 'mock', DATA_FILE: 'memory' });
    const { app, auth } = createApp({ config, store: new JsonStore(null) });
    expect(auth.enabled).toBe(false);

    const { body } = await request(app).get('/healthz').expect(200);
    expect(body.authRequired).toBe(false);
    await request(app).get('/v1/users').expect(200);
  });
});
