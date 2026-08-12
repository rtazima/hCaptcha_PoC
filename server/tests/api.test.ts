import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JsonStore } from '../src/db/json.js';
import type { Store } from '../src/db/types.js';
import type {
  EnrollResponse,
  IdentifyResponse,
  RawSample,
  SessionInitResponse,
  VerifyResponse,
} from '../src/biometrics/contract.js';
import { generateSample, makeBotProfile, makeProfile, makeRng, type BehaviorProfile } from '../src/simulator/synth.js';

const config = loadConfig({ HCAPTCHA_MODE: 'mock', DATA_FILE: 'memory' });

interface Harness {
  app: Express;
  store: Store;
  rng: ReturnType<typeof makeRng>;
}

function harness(env: Record<string, string> = {}): Harness {
  const cfg = loadConfig({ HCAPTCHA_MODE: 'mock', DATA_FILE: 'memory', ...env });
  const store = new JsonStore(null);
  const { app } = createApp({ config: cfg, store });
  return { app, store, rng: makeRng(4242) };
}

async function newSession(app: Express): Promise<SessionInitResponse> {
  const response = await request(app).post('/v1/sessions/init').send({}).expect(201);
  return response.body as SessionInitResponse;
}

async function sampleFor(h: Harness, profile: BehaviorProfile, task = 'teste'): Promise<RawSample> {
  const session = await newSession(h.app);
  return generateSample(profile, h.rng, { sessionId: session.sessionId, task });
}

async function enrollFully(
  h: Harness,
  profile: BehaviorProfile,
  samples = config.enrollment.samplesRequired,
): Promise<EnrollResponse> {
  let last: EnrollResponse | null = null;
  for (let i = 0; i < samples; i++) {
    const sample = await sampleFor(h, profile, `enroll-${i + 1}`);
    const response = await request(h.app)
      .post('/v1/enroll')
      .send({
        userId: profile.id,
        displayName: `Pessoa ${profile.id}`,
        captchaToken: 'mock:0.1',
        sample,
      })
      .expect(200);
    last = response.body as EnrollResponse;
  }
  return last!;
}

describe('rotas informativas', () => {
  it('GET /healthz responde saudável', async () => {
    const h = harness();
    const { body } = await request(h.app).get('/healthz').expect(200);
    expect(body.ok).toBe(true);
    expect(body.captchaMode).toBe('mock');
    expect(body.featureVersion).toBeGreaterThan(0);
  });

  it('GET /v1/config expõe sitekey, política e catálogo de features', async () => {
    const h = harness();
    const { body } = await request(h.app).get('/v1/config').expect(200);
    expect(body.captcha.sitekey).toBe(config.captcha.sitekey);
    expect(body.policy.baseThreshold).toBeGreaterThan(0);
    expect(body.features.list.length).toBe(body.features.count);
    expect(body.features.groups).toContain('keystroke');
    // segredo nunca vaza para o cliente
    expect(JSON.stringify(body)).not.toContain(config.captcha.secret);
  });

  it('devolve 404 estruturado para rota inexistente', async () => {
    const h = harness();
    const { body } = await request(h.app).get('/v1/nada').expect(404);
    expect(body.error).toBe('not_found');
  });
});

describe('sessões de captura', () => {
  it('cria sessão com prazo e modo do captcha', async () => {
    const h = harness();
    const session = await newSession(h.app);
    expect(session.sessionId).toHaveLength(36);
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
    expect(session.captchaMode).toBe('mock');
  });

  it('recusa reuso do mesmo sessionId', async () => {
    const h = harness();
    const profile = makeProfile('user-sessao', h.rng);
    const sample = await sampleFor(h, profile);

    await request(h.app)
      .post('/v1/enroll')
      .send({ userId: 'user-sessao', captchaToken: 'mock:0.1', sample })
      .expect(200);

    const { body } = await request(h.app)
      .post('/v1/enroll')
      .send({ userId: 'user-sessao', captchaToken: 'mock:0.1', sample })
      .expect(400);
    expect(body.error).toBe('session_already_used');
  });

  it('recusa sessionId desconhecido', async () => {
    const h = harness();
    const profile = makeProfile('user-x', h.rng);
    const sample = await sampleFor(h, profile);
    const { body } = await request(h.app)
      .post('/v1/enroll')
      .send({
        userId: 'user-x',
        captchaToken: 'mock:0.1',
        sample: { ...sample, sessionId: '00000000-0000-0000-0000-000000000000' },
      })
      .expect(400);
    expect(body.error).toBe('session_unknown');
  });
});

describe('validação de payload', () => {
  it('recusa corpo sem amostra', async () => {
    const h = harness();
    const { body } = await request(h.app)
      .post('/v1/verify')
      .send({ userId: 'alguem', captchaToken: 'mock:0.1' })
      .expect(400);
    expect(body.error).toBe('validation_error');
    expect(body.details.length).toBeGreaterThan(0);
  });

  it('recusa userId com caractere inválido', async () => {
    const h = harness();
    const profile = makeProfile('user-ok', h.rng);
    const sample = await sampleFor(h, profile);
    const { body } = await request(h.app)
      .post('/v1/enroll')
      .send({ userId: 'nome com espaço', captchaToken: 'mock:0.1', sample })
      .expect(400);
    expect(body.error).toBe('validation_error');
  });
});

describe('cadastro (enrollment)', () => {
  it('acumula amostras e só fecha o template ao atingir o mínimo', async () => {
    const h = harness();
    const profile = makeProfile('user-cadastro', h.rng);

    for (let i = 1; i <= config.enrollment.samplesRequired; i++) {
      const sample = await sampleFor(h, profile, `enroll-${i}`);
      const { body } = await request(h.app)
        .post('/v1/enroll')
        .send({ userId: profile.id, displayName: 'Fulano', captchaToken: 'mock:0.1', sample })
        .expect(200);
      const result = body as EnrollResponse;
      expect(result.samplesAccepted).toBe(i);
      expect(result.samplesRequired).toBe(config.enrollment.samplesRequired);
      expect(result.enrolled).toBe(i >= config.enrollment.samplesRequired);
      expect(result.quality.ok).toBe(true);
    }

    const { body } = await request(h.app).get('/v1/users').expect(200);
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({ userId: profile.id, enrolled: true, displayName: 'Fulano' });
  });

  it('recusa amostra de qualidade insuficiente sem gravá-la', async () => {
    const h = harness();
    const session = await newSession(h.app);
    const { body } = await request(h.app)
      .post('/v1/enroll')
      .send({
        userId: 'user-ruim',
        captchaToken: 'mock:0.1',
        sample: {
          sessionId: session.sessionId,
          task: 'vazio',
          device: { os: 'test' },
          keystrokes: [],
          taps: [],
          gestures: [],
          motion: [],
          timings: { durationMs: 200, firstInteractionMs: null },
        },
      })
      .expect(200);

    const result = body as EnrollResponse;
    expect(result.rejected?.reason).toBe('low_capture_quality');
    expect(result.samplesAccepted).toBe(0);
    expect(result.enrolled).toBe(false);
    expect(result.quality.issues.length).toBeGreaterThan(0);
  });

  it('bloqueia cadastro quando o hCaptcha aponta risco alto', async () => {
    const h = harness();
    const profile = makeProfile('user-risco', h.rng);
    const sample = await sampleFor(h, profile);
    const { body } = await request(h.app)
      .post('/v1/enroll')
      .send({ userId: profile.id, captchaToken: 'mock:0.95', sample })
      .expect(403);
    expect(body.error).toBe('captcha_high_risk');
    expect(body.details.captcha.riskBand).toBe('high');
  });

  it('rejeita token de captcha inválido', async () => {
    const h = harness();
    const profile = makeProfile('user-token', h.rng);
    const sample = await sampleFor(h, profile);
    const { body } = await request(h.app)
      .post('/v1/enroll')
      .send({ userId: profile.id, captchaToken: 'mock:fail', sample })
      .expect(403);
    expect(body.error).toBe('captcha_rejected');
  });
});

describe('verificação 1:1', () => {
  it('libera o dono do template e nega o impostor', async () => {
    const h = harness();
    const alice = makeProfile('user-alice', h.rng);
    const bob = makeProfile('user-bob', h.rng);
    await enrollFully(h, alice);
    await enrollFully(h, bob);

    const genuineSample = await sampleFor(h, alice, 'verify');
    const genuine = (
      await request(h.app)
        .post('/v1/verify')
        .send({ userId: alice.id, captchaToken: 'mock:0.05', sample: genuineSample })
        .expect(200)
    ).body as VerifyResponse;

    expect(genuine.decision).toBe('allow');
    expect(genuine.reasons).toContain('biometric_match');
    expect(genuine.match.similarity).toBeGreaterThan(genuine.threshold);
    expect(genuine.match.perGroup.keystroke).toBeGreaterThanOrEqual(0);
    expect(genuine.match.dimensionsCompared).toBeGreaterThan(30);
    expect(genuine.latencyMs).toBeGreaterThanOrEqual(0);

    const impostorSample = await sampleFor(h, bob, 'verify');
    const impostor = (
      await request(h.app)
        .post('/v1/verify')
        .send({ userId: alice.id, captchaToken: 'mock:0.05', sample: impostorSample })
        .expect(200)
    ).body as VerifyResponse;

    expect(impostor.decision).not.toBe('allow');
    expect(impostor.match.similarity).toBeLessThan(genuine.match.similarity);
  });

  it('nega comportamento robótico mesmo com token de captcha válido', async () => {
    const h = harness();
    const human = makeProfile('user-humano', h.rng);
    await enrollFully(h, human);

    const botSample = await sampleFor(h, makeBotProfile('bot'), 'verify');
    const result = (
      await request(h.app)
        .post('/v1/verify')
        .send({ userId: human.id, captchaToken: 'mock:0.05', sample: botSample })
        .expect(200)
    ).body as VerifyResponse;

    expect(result.captcha.success).toBe(true);
    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('biometric_mismatch');
  });

  it('sobe o limiar e pede step-up quando o risco do captcha é alto', async () => {
    const h = harness();
    const profile = makeProfile('user-stepup', h.rng);
    await enrollFully(h, profile);

    const baixo = (
      await request(h.app)
        .post('/v1/verify')
        .send({
          userId: profile.id,
          captchaToken: 'mock:0.05',
          sample: await sampleFor(h, profile, 'verify'),
        })
        .expect(200)
    ).body as VerifyResponse;

    const alto = (
      await request(h.app)
        .post('/v1/verify')
        .send({
          userId: profile.id,
          captchaToken: 'mock:0.9',
          sample: await sampleFor(h, profile, 'verify'),
        })
        .expect(200)
    ).body as VerifyResponse;

    expect(baixo.decision).toBe('allow');
    expect(alto.threshold).toBeGreaterThan(baixo.threshold);
    expect(alto.decision).toBe('step_up');
    expect(alto.reasons).toContain('hcaptcha_high_risk');
  });

  it('nega quando o token do captcha é inválido, sem consumir a sessão', async () => {
    const h = harness();
    const profile = makeProfile('user-invalido', h.rng);
    await enrollFully(h, profile);
    const sample = await sampleFor(h, profile, 'verify');

    const negado = (
      await request(h.app)
        .post('/v1/verify')
        .send({ userId: profile.id, captchaToken: 'mock:fail', sample })
        .expect(200)
    ).body as VerifyResponse;
    expect(negado.decision).toBe('deny');
    expect(negado.reasons).toEqual(['captcha_invalid']);

    // a mesma sessão continua válida para uma nova tentativa legítima
    const liberado = (
      await request(h.app)
        .post('/v1/verify')
        .send({ userId: profile.id, captchaToken: 'mock:0.05', sample })
        .expect(200)
    ).body as VerifyResponse;
    expect(liberado.decision).toBe('allow');
  });

  it('nega usuário sem template concluído', async () => {
    const h = harness();
    const profile = makeProfile('user-parcial', h.rng);
    await enrollFully(h, profile, 2);

    const result = (
      await request(h.app)
        .post('/v1/verify')
        .send({
          userId: profile.id,
          captchaToken: 'mock:0.05',
          sample: await sampleFor(h, profile, 'verify'),
        })
        .expect(200)
    ).body as VerifyResponse;
    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('not_enrolled');
  });

  it('devolve 404 para usuário inexistente', async () => {
    const h = harness();
    const profile = makeProfile('user-fantasma', h.rng);
    const { body } = await request(h.app)
      .post('/v1/verify')
      .send({
        userId: 'nao-existe',
        captchaToken: 'mock:0.05',
        sample: await sampleFor(h, profile, 'verify'),
      })
      .expect(404);
    expect(body.error).toBe('user_not_found');
  });

  it('bloqueia replay de token quando o uso único está ligado', async () => {
    const h = harness({ HCAPTCHA_ENFORCE_SINGLE_USE: '1' });
    const profile = makeProfile('user-replay', h.rng);

    const primeira = await request(h.app)
      .post('/v1/enroll')
      .send({
        userId: profile.id,
        captchaToken: 'mock:0.1',
        sample: await sampleFor(h, profile, 'enroll-1'),
      })
      .expect(200);
    expect((primeira.body as EnrollResponse).samplesAccepted).toBe(1);

    const { body } = await request(h.app)
      .post('/v1/enroll')
      .send({
        userId: profile.id,
        captchaToken: 'mock:0.1',
        sample: await sampleFor(h, profile, 'enroll-2'),
      })
      .expect(403);
    expect(body.error).toBe('captcha_rejected');
    expect(body.details.captcha.reasons).toContain('token-replay');
  });
});

describe('identificação 1:N', () => {
  let h: Harness;
  let profiles: BehaviorProfile[];

  beforeEach(async () => {
    h = harness();
    profiles = ['ana', 'bruno', 'carla', 'diego', 'elisa'].map((name) =>
      makeProfile(`user-${name}`, h.rng),
    );
    for (const profile of profiles) await enrollFully(h, profile);
  });

  it('encontra a pessoa certa e ordena o ranking', async () => {
    const alvo = profiles[2];
    const result = (
      await request(h.app)
        .post('/v1/identify')
        .send({
          captchaToken: 'mock:0.05',
          sample: await sampleFor(h, alvo, 'identify'),
          topK: 5,
        })
        .expect(200)
    ).body as IdentifyResponse;

    expect(result.candidates[0].userId).toBe(alvo.id);
    expect(result.candidates[0].rank).toBe(1);
    expect(result.candidates).toHaveLength(5);
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].match.similarity).toBeGreaterThanOrEqual(
        result.candidates[i].match.similarity,
      );
    }
    expect(result.decision).toBe('allow');
    expect(result.matchedUserId).toBe(alvo.id);
    expect(result.margin).toBeGreaterThan(result.requiredMargin);
  });

  it('respeita topK', async () => {
    const result = (
      await request(h.app)
        .post('/v1/identify')
        .send({
          captchaToken: 'mock:0.05',
          sample: await sampleFor(h, profiles[0], 'identify'),
          topK: 2,
        })
        .expect(200)
    ).body as IdentifyResponse;
    expect(result.candidates).toHaveLength(2);
  });

  it('nega quem não está na galeria', async () => {
    const estranho = makeProfile('user-estranho', h.rng);
    const result = (
      await request(h.app)
        .post('/v1/identify')
        .send({ captchaToken: 'mock:0.05', sample: await sampleFor(h, estranho, 'identify') })
        .expect(200)
    ).body as IdentifyResponse;

    expect(result.decision).not.toBe('allow');
    expect(result.matchedUserId).toBeNull();
  });

  it('exige limiar mais rígido que o 1:1', async () => {
    const alvo = profiles[1];
    const identifyResult = (
      await request(h.app)
        .post('/v1/identify')
        .send({ captchaToken: 'mock:0.05', sample: await sampleFor(h, alvo, 'identify') })
        .expect(200)
    ).body as IdentifyResponse;
    const verifyResult = (
      await request(h.app)
        .post('/v1/verify')
        .send({
          userId: alvo.id,
          captchaToken: 'mock:0.05',
          sample: await sampleFor(h, alvo, 'verify'),
        })
        .expect(200)
    ).body as VerifyResponse;

    expect(identifyResult.threshold).toBeGreaterThan(verifyResult.threshold);
  });

  it('nega quando a galeria está vazia', async () => {
    const vazio = harness();
    const profile = makeProfile('user-solo', vazio.rng);
    const result = (
      await request(vazio.app)
        .post('/v1/identify')
        .send({ captchaToken: 'mock:0.05', sample: await sampleFor(vazio, profile, 'identify') })
        .expect(200)
    ).body as IdentifyResponse;
    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('empty_gallery');
    expect(result.candidates).toEqual([]);
  });
});

describe('administração e auditoria', () => {
  it('expõe template e estatística do corpus para depuração', async () => {
    const h = harness();
    const profile = makeProfile('user-debug', h.rng);
    await enrollFully(h, profile);

    const { body } = await request(h.app).get(`/v1/users/${profile.id}/template`).expect(200);
    expect(body.template.samples).toBe(config.enrollment.samplesRequired);
    expect(body.template.centroid.length).toBe(body.template.featureNames.length);
    expect(body.samples).toHaveLength(config.enrollment.samplesRequired);
    expect(body.corpusStats.scales.every((s: number) => s > 0)).toBe(true);
  });

  it('apaga usuário e o remove da galeria', async () => {
    const h = harness();
    const profile = makeProfile('user-apagar', h.rng);
    await enrollFully(h, profile);

    await request(h.app).delete(`/v1/users/${profile.id}`).expect(204);
    await request(h.app).get(`/v1/users/${profile.id}/template`).expect(404);
    const { body } = await request(h.app).get('/v1/users').expect(200);
    expect(body.users).toEqual([]);
  });

  it('devolve 404 ao apagar usuário inexistente', async () => {
    const h = harness();
    const { body } = await request(h.app).delete('/v1/users/nao-existe').expect(404);
    expect(body.error).toBe('user_not_found');
  });

  it('registra trilha de auditoria das decisões', async () => {
    const h = harness();
    const profile = makeProfile('user-auditoria', h.rng);
    await enrollFully(h, profile);
    await request(h.app)
      .post('/v1/verify')
      .send({
        userId: profile.id,
        captchaToken: 'mock:0.05',
        sample: await sampleFor(h, profile, 'verify'),
      })
      .expect(200);

    const { body } = await request(h.app).get('/v1/audit?limit=10').expect(200);
    expect(body.events[0].kind).toBe('verify');
    expect(body.events[0].decision).toBe('allow');
    expect(body.events[0].risk).toBeCloseTo(0.05, 6);
    expect(body.events.some((e: { kind: string }) => e.kind === 'enroll')).toBe(true);
  });

  it('zera a base pelo endpoint de reset', async () => {
    const h = harness();
    const profile = makeProfile('user-reset', h.rng);
    await enrollFully(h, profile);
    await request(h.app).post('/v1/admin/reset').send({}).expect(200);
    const { body } = await request(h.app).get('/v1/users').expect(200);
    expect(body.users).toEqual([]);
  });
});
