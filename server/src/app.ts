/** Fábrica do app Express. Sem side effects: usada pelo servidor, testes e simulador. */
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import type { AppConfig } from './config.js';
import type { Store } from './db/types.js';
import { BiometricService, HttpError } from './service.js';
import { type CaptchaVerifier, createCaptchaVerifier } from './hcaptcha/verify.js';
import { enrollSchema, identifySchema, verifySchema } from './schemas.js';
import {
  FEATURES,
  FEATURE_GROUPS,
  FEATURE_VERSION,
  GROUP_WEIGHTS,
} from './biometrics/features.js';
import { type AuthConfig, apiKeyAuth, buildAuthConfig } from './auth.js';
import { AuthConfigError } from './auth.js';
import { CryptoConfigError, SealedDataError, createSealer } from './crypto/atRest.js';

export interface CreateAppOptions {
  config: AppConfig;
  /**
   * Obrigatório: criar o store é assíncrono quando é Postgres (migrações), e
   * uma fábrica async aqui contaminaria todos os pontos de uso. Use
   * `createStore(config)` de `./db/index.js`.
   */
  store: Store;
  verifier?: CaptchaVerifier;
}

export interface AppBundle {
  app: express.Express;
  store: Store;
  service: BiometricService;
  auth: AuthConfig;
  /** true quando os campos biométricos são cifrados em repouso */
  encryptionEnabled: boolean;
}

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? undefined;
}

/** Envolve handlers async para que rejeições cheguem ao middleware de erro. */
function wrap(handler: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

export function createApp(options: CreateAppOptions): AppBundle {
  const { config, store } = options;
  // o sealer aqui só reporta o estado no /healthz; quem cifra é o store, que já
  // recebeu o seu na construção
  const sealer = createSealer(config.encryptionKey);
  const verifier = options.verifier ?? createCaptchaVerifier(config);
  const service = new BiometricService(store, config, verifier);
  const auth = buildAuthConfig(config.apiKeys);

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '4mb' }));
  app.use(apiKeyAuth(auth));

  app.get(
    '/healthz',
    wrap(async (_req, res) => {
      res.json({
        ok: true,
        featureVersion: FEATURE_VERSION,
        captchaMode: config.captcha.mode,
        users: (await service.listUsers()).length,
        uptimeSec: Math.round(process.uptime()),
        storage: store.kind,
        // o cliente precisa saber se deve mandar chave, mas não qual
        authRequired: auth.enabled,
        encryptionAtRest: sealer.enabled,
      });
    }),
  );

  /** Configuração pública — o app mobile não hardcoda sitekey nem limiares. */
  app.get('/v1/config', (_req, res) => {
    res.json({
      captcha: {
        mode: config.captcha.mode,
        sitekey: config.captcha.sitekey,
        rqdata: config.captcha.rqdata,
        enforceSingleUse: config.captcha.enforceSingleUse,
      },
      enrollment: config.enrollment,
      policy: config.policy,
      match: {
        calibrationMidpoint: config.match.calibrationMidpoint,
        calibrationSteepness: config.match.calibrationSteepness,
        shrinkage: config.match.shrinkage,
      },
      features: {
        version: FEATURE_VERSION,
        count: FEATURES.length,
        groups: FEATURE_GROUPS,
        groupWeights: GROUP_WEIGHTS,
        list: FEATURES,
      },
    });
  });

  app.post(
    '/v1/sessions/init',
    wrap(async (_req, res) => {
      res.status(201).json(await service.initSession());
    }),
  );

  app.post(
    '/v1/enroll',
    wrap(async (req, res) => {
      const body = enrollSchema.parse(req.body);
      res.json(await service.enroll(body, clientIp(req)));
    }),
  );

  app.post(
    '/v1/verify',
    wrap(async (req, res) => {
      const body = verifySchema.parse(req.body);
      res.json(await service.verify(body, clientIp(req)));
    }),
  );

  app.post(
    '/v1/identify',
    wrap(async (req, res) => {
      const body = identifySchema.parse(req.body);
      res.json(await service.identify(body, clientIp(req)));
    }),
  );

  app.get(
    '/v1/users',
    wrap(async (_req, res) => {
      res.json({ users: await service.listUsers() });
    }),
  );

  app.get(
    '/v1/users/:userId/template',
    wrap(async (req, res) => {
      const user = await store.getUser(String(req.params.userId));
      if (!user) {
        res.status(404).json({ error: 'user_not_found', message: 'Usuário não encontrado.' });
        return;
      }
      res.json({
        userId: user.userId,
        displayName: user.displayName,
        samples: user.samples.map((s) => ({
          sampleId: s.sampleId,
          createdAt: s.createdAt,
          task: s.task,
          quality: s.quality,
        })),
        template: user.template
          ? {
              ...user.template,
              featureNames: FEATURES.map((f) => f.name),
            }
          : null,
        corpusStats: await store.corpusStats(),
      });
    }),
  );

  app.delete(
    '/v1/users/:userId',
    wrap(async (req, res) => {
      await service.deleteUser(String(req.params.userId));
      res.status(204).end();
    }),
  );

  app.get(
    '/v1/audit',
    wrap(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      res.json({ events: await store.listEvents(limit) });
    }),
  );

  /** Zera a base — atalho de demonstração, protegido por flag. */
  app.post(
    '/v1/admin/reset',
    wrap(async (req, res) => {
      if (config.captcha.mode === 'live' && req.headers['x-confirm-reset'] !== 'yes') {
        res.status(403).json({
          error: 'reset_requires_confirmation',
          message: 'Em modo live envie o header x-confirm-reset: yes.',
        });
        return;
      }
      await store.reset();
      res.json({ ok: true });
    }),
  );

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `Rota ${req.method} ${req.path} inexistente.` });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof CryptoConfigError || error instanceof SealedDataError) {
      // nunca 500 genérico aqui: erro de chave é operacional e precisa ser óbvio
      res.status(500).json({ error: 'encryption_error', message: error.message });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'validation_error',
        message: 'Payload inválido.',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({
        error: error.code,
        message: error.message,
        details: error.details,
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error('[erro-nao-tratado]', error);
    res.status(500).json({ error: 'internal_error', message });
  });

  return { app, store, service, auth, encryptionEnabled: sealer.enabled };
}

export { AuthConfigError };
