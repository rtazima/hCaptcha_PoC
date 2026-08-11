import { DEFAULT_POLICY, type DecisionPolicy } from './biometrics/decision.js';
import { DEFAULT_MATCH_PARAMS, type MatchParams } from './biometrics/match.js';

/** Chaves públicas de teste do hCaptcha (nunca desafiam, sempre passam). */
export const HCAPTCHA_TEST_SITEKEY = '10000000-ffff-ffff-ffff-000000000001';
export const HCAPTCHA_TEST_SECRET = '0x0000000000000000000000000000000000000000';

export type CaptchaMode = 'live' | 'test' | 'mock';

export interface AppConfig {
  port: number;
  host: string;
  dataFile: string | null;
  /** definido => usa Postgres em vez do arquivo JSON */
  databaseUrl: string | null;
  corsOrigin: string;
  captcha: {
    mode: CaptchaMode;
    sitekey: string;
    secret: string;
    verifyUrl: string;
    /** rqdata opcional (Enterprise) repassado ao app */
    rqdata: string | null;
    timeoutMs: number;
    enforceSingleUse: boolean;
    /** risco assumido quando o sitekey não devolve score (não-Enterprise) */
    derivedRiskPass: number;
    derivedRiskFail: number;
    /** risco devolvido no modo mock quando o token não especifica um */
    mockDefaultRisk: number;
  };
  enrollment: {
    samplesRequired: number;
    maxSamples: number;
    /** reforça o template com verificações claramente genuínas (default: off) */
    adaptOnAllow: boolean;
  };
  match: MatchParams;
  policy: DecisionPolicy;
  sessionTtlMs: number;
  /** chaves de API em claro; ficam só em memória e viram hash no boot */
  apiKeys: string[];
  /** chave AES-256 (base64 ou hex) para cifrar os campos biométricos em repouso */
  encryptionKey: string | null;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = value == null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function resolveMode(env: NodeJS.ProcessEnv): CaptchaMode {
  const raw = (env.HCAPTCHA_MODE ?? '').toLowerCase();
  if (raw === 'live' || raw === 'test' || raw === 'mock') return raw;
  // sem modo explícito: "test" quando as chaves são as públicas de teste
  const secret = env.HCAPTCHA_SECRET ?? HCAPTCHA_TEST_SECRET;
  return secret === HCAPTCHA_TEST_SECRET ? 'test' : 'live';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = resolveMode(env);
  return {
    port: num(env.PORT, 8787),
    host: env.HOST ?? '0.0.0.0',
    dataFile: env.DATA_FILE === 'memory' ? null : (env.DATA_FILE ?? 'data/db.json'),
    databaseUrl: env.DATABASE_URL?.trim() || null,
    corsOrigin: env.CORS_ORIGIN ?? '*',
    captcha: {
      mode,
      sitekey: env.HCAPTCHA_SITEKEY ?? HCAPTCHA_TEST_SITEKEY,
      secret: env.HCAPTCHA_SECRET ?? HCAPTCHA_TEST_SECRET,
      verifyUrl: env.HCAPTCHA_VERIFY_URL ?? 'https://api.hcaptcha.com/siteverify',
      rqdata: env.HCAPTCHA_RQDATA ?? null,
      timeoutMs: num(env.HCAPTCHA_TIMEOUT_MS, 8000),
      // as chaves de teste devolvem sempre o mesmo token, então uso único só em live
      enforceSingleUse: bool(env.HCAPTCHA_ENFORCE_SINGLE_USE, mode === 'live'),
      derivedRiskPass: num(env.HCAPTCHA_DERIVED_RISK_PASS, 0.15),
      derivedRiskFail: num(env.HCAPTCHA_DERIVED_RISK_FAIL, 0.9),
      mockDefaultRisk: num(env.HCAPTCHA_MOCK_RISK, 0.1),
    },
    enrollment: {
      samplesRequired: num(env.ENROLL_SAMPLES_REQUIRED, 5),
      maxSamples: num(env.ENROLL_MAX_SAMPLES, 20),
      adaptOnAllow: bool(env.ENROLL_ADAPT_ON_ALLOW, false),
    },
    match: {
      ...DEFAULT_MATCH_PARAMS,
      calibrationMidpoint: num(env.MATCH_MIDPOINT, DEFAULT_MATCH_PARAMS.calibrationMidpoint),
      calibrationSteepness: num(env.MATCH_STEEPNESS, DEFAULT_MATCH_PARAMS.calibrationSteepness),
      shrinkage: num(env.MATCH_SHRINKAGE, DEFAULT_MATCH_PARAMS.shrinkage),
    },
    policy: {
      ...DEFAULT_POLICY,
      baseThreshold: num(env.POLICY_THRESHOLD, DEFAULT_POLICY.baseThreshold),
      stepUpBand: num(env.POLICY_STEP_UP_BAND, DEFAULT_POLICY.stepUpBand),
      identifyMargin: num(env.POLICY_IDENTIFY_MARGIN, DEFAULT_POLICY.identifyMargin),
      identifyThresholdBoost: num(
        env.POLICY_IDENTIFY_BOOST,
        DEFAULT_POLICY.identifyThresholdBoost,
      ),
      highRiskForcesStepUp: bool(
        env.POLICY_HIGH_RISK_STEP_UP,
        DEFAULT_POLICY.highRiskForcesStepUp,
      ),
    },
    sessionTtlMs: num(env.SESSION_TTL_MS, 10 * 60 * 1000),
    apiKeys: (env.API_KEYS ?? env.API_KEY ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
    encryptionKey: env.TEMPLATE_ENCRYPTION_KEY?.trim() || null,
  };
}
