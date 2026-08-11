import { describe, expect, it, vi } from 'vitest';
import { HCAPTCHA_TEST_SECRET, HCAPTCHA_TEST_SITEKEY, loadConfig } from '../src/config.js';
import { createCaptchaVerifier, replayedTokenAssessment } from '../src/hcaptcha/verify.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolução de modo', () => {
  it('assume test quando a chave secreta é a pública de teste', () => {
    expect(loadConfig({}).captcha.mode).toBe('test');
    expect(loadConfig({}).captcha.sitekey).toBe(HCAPTCHA_TEST_SITEKEY);
    expect(loadConfig({}).captcha.secret).toBe(HCAPTCHA_TEST_SECRET);
  });

  it('assume live quando há uma chave secreta de verdade', () => {
    const config = loadConfig({ HCAPTCHA_SECRET: 'ES_umsegredoqualquer' });
    expect(config.captcha.mode).toBe('live');
    // uso único do token só é exigido em live
    expect(config.captcha.enforceSingleUse).toBe(true);
    expect(loadConfig({}).captcha.enforceSingleUse).toBe(false);
  });

  it('respeita HCAPTCHA_MODE explícito', () => {
    expect(loadConfig({ HCAPTCHA_MODE: 'mock' }).captcha.mode).toBe('mock');
    expect(loadConfig({ HCAPTCHA_MODE: 'LIVE' }).captcha.mode).toBe('live');
  });
});

describe('verificador em modo mock', () => {
  const config = loadConfig({ HCAPTCHA_MODE: 'mock' });
  const verifier = createCaptchaVerifier(config, vi.fn() as unknown as typeof fetch);

  it('lê o risco embutido no token', async () => {
    const result = await verifier.verify('mock:0.85');
    expect(result.success).toBe(true);
    expect(result.risk).toBeCloseTo(0.85, 6);
    expect(result.riskBand).toBe('high');
    expect(result.mode).toBe('mock');
  });

  it('simula falha de token', async () => {
    const result = await verifier.verify('mock:fail');
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain('invalid-input-response');
  });

  it('usa o risco default para token sem score', async () => {
    const result = await verifier.verify('qualquer-token');
    expect(result.success).toBe(true);
    expect(result.risk).toBeCloseTo(config.captcha.mockDefaultRisk, 6);
    expect(result.derived).toBe(true);
  });

  it('não faz chamada de rede', async () => {
    const spy = vi.fn();
    const offline = createCaptchaVerifier(config, spy as unknown as typeof fetch);
    await offline.verify('mock:0.2');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('verificador contra /siteverify', () => {
  const config = loadConfig({ HCAPTCHA_MODE: 'live', HCAPTCHA_SECRET: 'ES_segredo' });

  it('envia secret, response, remoteip e sitekey no formato form-urlencoded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, score: 0.2 }));
    const verifier = createCaptchaVerifier(config, fetchMock as unknown as typeof fetch);
    await verifier.verify('token-abc', '203.0.113.7');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.hcaptcha.com/siteverify');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(init.body as string);
    expect(params.get('secret')).toBe('ES_segredo');
    expect(params.get('response')).toBe('token-abc');
    expect(params.get('remoteip')).toBe('203.0.113.7');
    expect(params.get('sitekey')).toBe(HCAPTCHA_TEST_SITEKEY);
  });

  it('usa o score do Enterprise como risco, sem derivar', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        score: 0.92,
        score_reason: ['bot-signals', 'automation-framework'],
        hostname: 'app.exemplo.com',
        challenge_ts: '2026-08-11T12:00:00.000Z',
      }),
    );
    const verifier = createCaptchaVerifier(config, fetchMock as unknown as typeof fetch);
    const result = await verifier.verify('token');

    expect(result.success).toBe(true);
    expect(result.risk).toBeCloseTo(0.92, 6);
    expect(result.riskBand).toBe('high');
    expect(result.derived).toBe(false);
    expect(result.reasons).toEqual(['bot-signals', 'automation-framework']);
    expect(result.hostname).toBe('app.exemplo.com');
  });

  it('deriva o risco quando o sitekey não é Enterprise (sem score)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    const verifier = createCaptchaVerifier(config, fetchMock as unknown as typeof fetch);
    const result = await verifier.verify('token');

    expect(result.derived).toBe(true);
    expect(result.risk).toBeCloseTo(config.captcha.derivedRiskPass, 6);
    expect(result.riskBand).toBe('low');
  });

  it('propaga error-codes de token inválido', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] }),
    );
    const verifier = createCaptchaVerifier(config, fetchMock as unknown as typeof fetch);
    const result = await verifier.verify('token-velho');

    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(['invalid-input-response']);
    expect(result.risk).toBeCloseTo(config.captcha.derivedRiskFail, 6);
  });

  it('limita o score fora de faixa a 0..1', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, score: 7 }));
    const verifier = createCaptchaVerifier(config, fetchMock as unknown as typeof fetch);
    expect((await verifier.verify('t')).risk).toBe(1);
  });

  it('falha fechado em erro HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const verifier = createCaptchaVerifier(config, fetchMock as unknown as typeof fetch);
    const result = await verifier.verify('token');
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain('siteverify-http-500');
  });

  it('falha fechado quando a rede cai, com código distinguível', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const verifier = createCaptchaVerifier(config, fetchMock as unknown as typeof fetch);
    const result = await verifier.verify('token');
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain('siteverify-unreachable');
  });

  it('rejeita token ausente sem chamar a rede', async () => {
    const fetchMock = vi.fn();
    const verifier = createCaptchaVerifier(config, fetchMock as unknown as typeof fetch);
    const result = await verifier.verify('');
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain('missing-input-response');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('replayedTokenAssessment', () => {
  it('marca replay como falha de risco alto', () => {
    const result = replayedTokenAssessment(loadConfig({ HCAPTCHA_MODE: 'live', HCAPTCHA_SECRET: 'x' }));
    expect(result.success).toBe(false);
    expect(result.reasons).toContain('token-replay');
    expect(result.riskBand).toBe('high');
  });
});
