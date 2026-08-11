/**
 * Motor de decisão: funde o *risco* do hCaptcha com a *identidade* biométrica.
 *
 * São dois eixos independentes e é isso que a PoC quer demonstrar:
 *   - hCaptcha invisível responde "é um humano legítimo agindo agora?"
 *   - o template comportamental responde "é o mesmo humano de antes?"
 *
 * A política aqui é deliberadamente simples e legível: o risco desloca o limiar
 * biométrico (step-up adaptativo) em vez de somar num score único opaco.
 */
import type { CaptchaAssessment, Decision, MatchBreakdown, QualityReport } from './contract.js';

export interface DecisionPolicy {
  /** limiar de similaridade em risco médio */
  baseThreshold: number;
  /** faixa abaixo do limiar que resulta em step-up em vez de negar */
  stepUpBand: number;
  /** ajuste do limiar por faixa de risco */
  riskAdjust: { low: number; medium: number; high: number };
  /** risco < lowRiskMax => faixa baixa */
  lowRiskMax: number;
  /** risco >= highRiskMin => faixa alta */
  highRiskMin: number;
  /** em risco alto, o melhor resultado possível é step-up */
  highRiskForcesStepUp: boolean;
  /** margem mínima entre 1º e 2º colocado no 1:N (rejeição open-set) */
  identifyMargin: number;
  /**
   * Acréscimo no limiar quando a busca é 1:N.
   * O 1:N pega o *máximo* entre N comparações, então a chance de um impostor
   * cruzar o limiar cresce com o tamanho da galeria: FAR_1:N ~ 1-(1-FAR)^N.
   * Identificar é intrinsecamente mais difícil que verificar e o limiar
   * precisa refletir isso.
   */
  identifyThresholdBoost: number;
}

export const DEFAULT_POLICY: DecisionPolicy = {
  baseThreshold: 0.6,
  stepUpBand: 0.12,
  riskAdjust: { low: -0.05, medium: 0, high: 0.15 },
  lowRiskMax: 0.3,
  highRiskMin: 0.7,
  highRiskForcesStepUp: true,
  identifyMargin: 0.05,
  identifyThresholdBoost: 0.15,
};

export function riskBandOf(risk: number, policy: DecisionPolicy): CaptchaAssessment['riskBand'] {
  if (risk < policy.lowRiskMax) return 'low';
  if (risk >= policy.highRiskMin) return 'high';
  return 'medium';
}

export function thresholdFor(
  band: CaptchaAssessment['riskBand'],
  policy: DecisionPolicy,
  mode: 'verify' | 'identify' = 'verify',
): number {
  const boost = mode === 'identify' ? policy.identifyThresholdBoost : 0;
  const adjusted = policy.baseThreshold + policy.riskAdjust[band] + boost;
  return Number(Math.min(0.98, Math.max(0.02, adjusted)).toFixed(4));
}

export interface DecisionInput {
  match: MatchBreakdown | null;
  quality: QualityReport;
  captcha: CaptchaAssessment;
  policy: DecisionPolicy;
}

export interface DecisionOutput {
  decision: Decision;
  reasons: string[];
  threshold: number;
}

/** Rebaixa (nunca promove) a decisão corrente. */
function downgrade(current: Decision, to: Decision): Decision {
  const rank: Record<Decision, number> = { allow: 2, step_up: 1, deny: 0 };
  return rank[to] < rank[current] ? to : current;
}

export function decideVerify(input: DecisionInput): DecisionOutput {
  const { match, quality, captcha, policy } = input;
  const reasons: string[] = [];
  const threshold = thresholdFor(captcha.riskBand, policy);

  if (!captcha.success) {
    return { decision: 'deny', reasons: ['captcha_invalid'], threshold };
  }

  let decision: Decision = 'allow';

  if (!match) {
    reasons.push('no_comparable_features');
    decision = downgrade(decision, 'step_up');
  } else if (match.similarity >= threshold) {
    reasons.push('biometric_match');
  } else if (match.similarity >= threshold - policy.stepUpBand) {
    reasons.push('biometric_borderline');
    decision = downgrade(decision, 'step_up');
  } else {
    reasons.push('biometric_mismatch');
    decision = downgrade(decision, 'deny');
  }

  if (!quality.ok) {
    reasons.push('low_capture_quality');
    decision = downgrade(decision, 'step_up');
  }

  if (captcha.riskBand === 'high') {
    reasons.push('hcaptcha_high_risk');
    if (policy.highRiskForcesStepUp) decision = downgrade(decision, 'step_up');
  } else if (captcha.riskBand === 'medium') {
    reasons.push('hcaptcha_medium_risk');
  } else {
    reasons.push('hcaptcha_low_risk');
  }

  return { decision, reasons, threshold };
}

export interface IdentifyDecisionInput {
  /** ordenado por similaridade decrescente */
  ranked: Array<{ userId: string; match: MatchBreakdown }>;
  quality: QualityReport;
  captcha: CaptchaAssessment;
  policy: DecisionPolicy;
}

export interface IdentifyDecisionOutput extends DecisionOutput {
  matchedUserId: string | null;
  margin: number | null;
}

export function decideIdentify(input: IdentifyDecisionInput): IdentifyDecisionOutput {
  const { ranked, quality, captcha, policy } = input;
  const threshold = thresholdFor(captcha.riskBand, policy, 'identify');

  if (!captcha.success) {
    return {
      decision: 'deny',
      reasons: ['captcha_invalid'],
      threshold,
      matchedUserId: null,
      margin: null,
    };
  }

  if (ranked.length === 0) {
    return {
      decision: 'deny',
      reasons: ['empty_gallery'],
      threshold,
      matchedUserId: null,
      margin: null,
    };
  }

  const top = ranked[0];
  const runnerUp = ranked[1];
  const margin =
    runnerUp != null
      ? Number((top.match.similarity - runnerUp.match.similarity).toFixed(4))
      : null;

  const reasons: string[] = [];
  let decision: Decision = 'allow';
  let matchedUserId: string | null = top.userId;

  if (top.match.similarity >= threshold) {
    reasons.push('biometric_match');
    if (margin != null && margin < policy.identifyMargin) {
      reasons.push('ambiguous_candidates');
      decision = downgrade(decision, 'step_up');
    }
  } else if (top.match.similarity >= threshold - policy.stepUpBand) {
    reasons.push('biometric_borderline');
    decision = downgrade(decision, 'step_up');
  } else {
    reasons.push('no_match_in_gallery');
    decision = downgrade(decision, 'deny');
    matchedUserId = null;
  }

  if (!quality.ok) {
    reasons.push('low_capture_quality');
    decision = downgrade(decision, 'step_up');
  }

  if (captcha.riskBand === 'high') {
    reasons.push('hcaptcha_high_risk');
    if (policy.highRiskForcesStepUp) decision = downgrade(decision, 'step_up');
  } else if (captcha.riskBand === 'medium') {
    reasons.push('hcaptcha_medium_risk');
  } else {
    reasons.push('hcaptcha_low_risk');
  }

  if (decision !== 'allow') matchedUserId = decision === 'deny' ? null : matchedUserId;

  return { decision, reasons, threshold, matchedUserId, margin };
}
