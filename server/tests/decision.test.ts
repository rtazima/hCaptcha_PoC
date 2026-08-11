import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  decideIdentify,
  decideVerify,
  riskBandOf,
  thresholdFor,
} from '../src/biometrics/decision.js';
import type { CaptchaAssessment, MatchBreakdown, QualityReport } from '../src/biometrics/contract.js';

function captcha(overrides: Partial<CaptchaAssessment> = {}): CaptchaAssessment {
  const risk = overrides.risk ?? 0.1;
  return {
    success: true,
    risk,
    riskBand: riskBandOf(risk, DEFAULT_POLICY),
    reasons: [],
    derived: false,
    mode: 'mock',
    ...overrides,
  };
}

function match(similarity: number): MatchBreakdown {
  return {
    distance: 1,
    similarity,
    perGroup: { keystroke: 1 },
    topContributors: [],
    dimensionsCompared: 40,
  };
}

const goodQuality: QualityReport = {
  ok: true,
  score: 1,
  issues: [],
  counts: { keystrokes: 30, taps: 6, gestures: 5, motion: 100, durationMs: 9000 },
  availableGroups: ['keystroke', 'gesture', 'tap', 'motion', 'session'],
};
const badQuality: QualityReport = { ...goodQuality, ok: false, score: 0.2, issues: ['curta'] };

describe('faixas de risco', () => {
  it('classifica risco conforme a política', () => {
    expect(riskBandOf(0, DEFAULT_POLICY)).toBe('low');
    expect(riskBandOf(0.29, DEFAULT_POLICY)).toBe('low');
    expect(riskBandOf(0.3, DEFAULT_POLICY)).toBe('medium');
    expect(riskBandOf(0.69, DEFAULT_POLICY)).toBe('medium');
    expect(riskBandOf(0.7, DEFAULT_POLICY)).toBe('high');
    expect(riskBandOf(1, DEFAULT_POLICY)).toBe('high');
  });

  it('risco alto exige limiar maior que risco baixo', () => {
    const low = thresholdFor('low', DEFAULT_POLICY);
    const medium = thresholdFor('medium', DEFAULT_POLICY);
    const high = thresholdFor('high', DEFAULT_POLICY);
    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThan(high);
  });

  it('1:N usa limiar mais rígido que 1:1', () => {
    for (const band of ['low', 'medium', 'high'] as const) {
      expect(thresholdFor(band, DEFAULT_POLICY, 'identify')).toBeGreaterThan(
        thresholdFor(band, DEFAULT_POLICY, 'verify'),
      );
    }
  });

  it('mantém o limiar dentro de 0..1 mesmo com política agressiva', () => {
    const extrema = { ...DEFAULT_POLICY, baseThreshold: 0.95, riskAdjust: { low: 0, medium: 0, high: 0.5 } };
    expect(thresholdFor('high', extrema, 'identify')).toBeLessThanOrEqual(0.98);
  });
});

describe('decideVerify', () => {
  it('nega token inválido antes de olhar a biometria', () => {
    const result = decideVerify({
      match: match(0.99),
      quality: goodQuality,
      captcha: captcha({ success: false, risk: 0.9 }),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons).toEqual(['captcha_invalid']);
  });

  it('libera similaridade alta com risco baixo', () => {
    const result = decideVerify({
      match: match(0.9),
      quality: goodQuality,
      captcha: captcha({ risk: 0.05 }),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('allow');
    expect(result.reasons).toContain('biometric_match');
    expect(result.reasons).toContain('hcaptcha_low_risk');
  });

  it('nega similaridade claramente abaixo do limiar', () => {
    const result = decideVerify({
      match: match(0.1),
      quality: goodQuality,
      captcha: captcha(),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('biometric_mismatch');
  });

  it('pede step-up na faixa de fronteira', () => {
    const threshold = thresholdFor('low', DEFAULT_POLICY);
    const result = decideVerify({
      match: match(threshold - DEFAULT_POLICY.stepUpBand / 2),
      quality: goodQuality,
      captcha: captcha({ risk: 0.05 }),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('step_up');
    expect(result.reasons).toContain('biometric_borderline');
  });

  it('mesma similaridade muda de allow para step_up quando o risco sobe', () => {
    const similarity = 0.68;
    const baixo = decideVerify({
      match: match(similarity),
      quality: goodQuality,
      captcha: captcha({ risk: 0.05 }),
      policy: DEFAULT_POLICY,
    });
    const alto = decideVerify({
      match: match(similarity),
      quality: goodQuality,
      captcha: captcha({ risk: 0.95 }),
      policy: DEFAULT_POLICY,
    });
    expect(baixo.decision).toBe('allow');
    expect(alto.decision).not.toBe('allow');
    expect(alto.reasons).toContain('hcaptcha_high_risk');
    expect(alto.threshold).toBeGreaterThan(baixo.threshold);
  });

  it('risco alto nunca resulta em allow quando a política força step-up', () => {
    const result = decideVerify({
      match: match(0.999),
      quality: goodQuality,
      captcha: captcha({ risk: 0.99 }),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('step_up');
  });

  it('respeita a política quando o step-up forçado está desligado', () => {
    const result = decideVerify({
      match: match(0.999),
      quality: goodQuality,
      captcha: captcha({ risk: 0.99 }),
      policy: { ...DEFAULT_POLICY, highRiskForcesStepUp: false },
    });
    expect(result.decision).toBe('allow');
  });

  it('rebaixa para step-up quando a captura tem qualidade ruim', () => {
    const result = decideVerify({
      match: match(0.99),
      quality: badQuality,
      captcha: captcha(),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('step_up');
    expect(result.reasons).toContain('low_capture_quality');
  });

  it('qualidade ruim não promove uma rejeição biométrica', () => {
    const result = decideVerify({
      match: match(0.01),
      quality: badQuality,
      captcha: captcha(),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('deny');
  });

  it('pede step-up quando não há dimensão comparável', () => {
    const result = decideVerify({
      match: null,
      quality: goodQuality,
      captcha: captcha(),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('step_up');
    expect(result.reasons).toContain('no_comparable_features');
  });
});

describe('decideIdentify', () => {
  const ranked = (...sims: number[]) =>
    sims.map((s, i) => ({ userId: `user-${i + 1}`, match: match(s) }));

  it('nega galeria vazia', () => {
    const result = decideIdentify({
      ranked: [],
      quality: goodQuality,
      captcha: captcha(),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons).toEqual(['empty_gallery']);
    expect(result.matchedUserId).toBeNull();
  });

  it('identifica o 1º colocado com folga', () => {
    const result = decideIdentify({
      ranked: ranked(0.95, 0.3, 0.2),
      quality: goodQuality,
      captcha: captcha({ risk: 0.05 }),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('allow');
    expect(result.matchedUserId).toBe('user-1');
    expect(result.margin).toBeCloseTo(0.65, 6);
  });

  it('pede step-up quando 1º e 2º estão empatados', () => {
    const result = decideIdentify({
      ranked: ranked(0.95, 0.94),
      quality: goodQuality,
      captcha: captcha({ risk: 0.05 }),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('step_up');
    expect(result.reasons).toContain('ambiguous_candidates');
    // candidato preservado para revisão manual, mas sem liberar acesso
    expect(result.matchedUserId).toBe('user-1');
  });

  it('nega quem não está na galeria e não devolve usuário', () => {
    const result = decideIdentify({
      ranked: ranked(0.2, 0.15),
      quality: goodQuality,
      captcha: captcha(),
      policy: DEFAULT_POLICY,
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('no_match_in_gallery');
    expect(result.matchedUserId).toBeNull();
  });

  it('trata galeria de uma pessoa (sem margem calculável)', () => {
    const result = decideIdentify({
      ranked: ranked(0.95),
      quality: goodQuality,
      captcha: captcha({ risk: 0.05 }),
      policy: DEFAULT_POLICY,
    });
    expect(result.margin).toBeNull();
    expect(result.decision).toBe('allow');
  });

  it('exige mais similaridade que o 1:1 para a mesma pontuação', () => {
    const sim = thresholdFor('low', DEFAULT_POLICY) + 0.02;
    const verify = decideVerify({
      match: match(sim),
      quality: goodQuality,
      captcha: captcha({ risk: 0.05 }),
      policy: DEFAULT_POLICY,
    });
    const identify = decideIdentify({
      ranked: ranked(sim, 0.1),
      quality: goodQuality,
      captcha: captcha({ risk: 0.05 }),
      policy: DEFAULT_POLICY,
    });
    expect(verify.decision).toBe('allow');
    expect(identify.decision).not.toBe('allow');
  });
});
