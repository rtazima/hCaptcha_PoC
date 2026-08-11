/**
 * Cliente do /siteverify do hCaptcha.
 *
 * Endpoint: POST https://api.hcaptcha.com/siteverify (form-urlencoded)
 *   secret    (obrigatório) — chave secreta do sitekey
 *   response  (obrigatório) — token devolvido pelo widget/SDK
 *   remoteip  (opcional)    — IP do cliente
 *   sitekey   (opcional)    — reforça a validação do sitekey
 *
 * Resposta:
 *   { success, challenge_ts, hostname, credit, "error-codes": [],
 *     score, score_reason }   // score/score_reason só em contas Enterprise
 *
 * `score` é **risco**: 0.0 = sem risco, 1.0 = ameaça confirmada. É o oposto do
 * reCAPTCHA v3 e é a fonte do sinal comportamental passivo consumido aqui.
 */
import type { CaptchaAssessment } from '../biometrics/contract.js';
import type { AppConfig } from '../config.js';
import { riskBandOf } from '../biometrics/decision.js';

export interface SiteverifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  credit?: boolean;
  'error-codes'?: string[];
  score?: number;
  score_reason?: string[];
}

export interface CaptchaVerifier {
  verify(token: string, remoteIp?: string): Promise<CaptchaAssessment>;
}

const MOCK_PREFIX = 'mock:';

/**
 * Token de mock aceito somente quando `HCAPTCHA_MODE=mock`:
 *   "mock:0.85"       -> sucesso com risco 0.85
 *   "mock:fail"       -> success=false
 *   qualquer outro    -> sucesso com HCAPTCHA_MOCK_RISK
 */
function assessMock(token: string, config: AppConfig): CaptchaAssessment {
  const raw = token.startsWith(MOCK_PREFIX) ? token.slice(MOCK_PREFIX.length) : '';
  if (raw === 'fail') {
    return finalize(
      {
        success: false,
        risk: config.captcha.derivedRiskFail,
        reasons: ['mock-failure'],
        derived: true,
        mode: 'mock',
        errorCodes: ['invalid-input-response'],
      },
      config,
    );
  }
  // atenção: Number('') é 0, então string vazia tem de cair no default
  const parsed = raw.trim() === '' ? Number.NaN : Number(raw);
  const explicit = Number.isFinite(parsed);
  const risk = explicit ? parsed : config.captcha.mockDefaultRisk;
  return finalize(
    {
      success: true,
      risk: Math.min(1, Math.max(0, risk)),
      reasons: explicit ? ['mock-score'] : ['mock-default'],
      derived: !explicit,
      mode: 'mock',
      challengeTs: undefined,
    },
    config,
  );
}

type PartialAssessment = Omit<CaptchaAssessment, 'riskBand'>;

function finalize(assessment: PartialAssessment, config: AppConfig): CaptchaAssessment {
  return { ...assessment, riskBand: riskBandOf(assessment.risk, config.policy) };
}

export function createCaptchaVerifier(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): CaptchaVerifier {
  return {
    async verify(token: string, remoteIp?: string): Promise<CaptchaAssessment> {
      if (!token || typeof token !== 'string') {
        return finalize(
          {
            success: false,
            risk: config.captcha.derivedRiskFail,
            reasons: [],
            derived: true,
            mode: config.captcha.mode,
            errorCodes: ['missing-input-response'],
          },
          config,
        );
      }

      if (config.captcha.mode === 'mock') return assessMock(token, config);

      const body = new URLSearchParams({
        secret: config.captcha.secret,
        response: token,
      });
      if (remoteIp) body.set('remoteip', remoteIp);
      if (config.captcha.sitekey) body.set('sitekey', config.captcha.sitekey);

      let payload: SiteverifyResponse;
      try {
        const response = await fetchImpl(config.captcha.verifyUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: AbortSignal.timeout(config.captcha.timeoutMs),
        });
        if (!response.ok) {
          return finalize(
            {
              success: false,
              risk: config.captcha.derivedRiskFail,
              reasons: [],
              derived: true,
              mode: config.captcha.mode,
              errorCodes: [`siteverify-http-${response.status}`],
            },
            config,
          );
        }
        payload = (await response.json()) as SiteverifyResponse;
      } catch (error) {
        // falha de rede/timeout: fail-closed, mas com código distinguível
        return finalize(
          {
            success: false,
            risk: config.captcha.derivedRiskFail,
            reasons: [],
            derived: true,
            mode: config.captcha.mode,
            errorCodes: ['siteverify-unreachable', String((error as Error)?.name ?? 'Error')],
          },
          config,
        );
      }

      const hasScore = typeof payload.score === 'number' && Number.isFinite(payload.score);
      const risk = hasScore
        ? Math.min(1, Math.max(0, payload.score as number))
        : payload.success
          ? config.captcha.derivedRiskPass
          : config.captcha.derivedRiskFail;

      return finalize(
        {
          success: Boolean(payload.success),
          risk,
          reasons: payload.score_reason ?? [],
          derived: !hasScore,
          mode: config.captcha.mode,
          hostname: payload.hostname,
          challengeTs: payload.challenge_ts,
          errorCodes: payload['error-codes'],
        },
        config,
      );
    },
  };
}

/** Assessment usado quando o token já foi consumido (proteção antirreplay). */
export function replayedTokenAssessment(config: AppConfig): CaptchaAssessment {
  return finalize(
    {
      success: false,
      risk: config.captcha.derivedRiskFail,
      reasons: ['token-replay'],
      derived: true,
      mode: config.captcha.mode,
      errorCodes: ['token-already-seen'],
    },
    config,
  );
}
