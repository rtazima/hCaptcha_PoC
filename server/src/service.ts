/**
 * Serviço de domínio: orquestra hCaptcha -> features -> template -> decisão.
 * As rotas HTTP são casca fina em volta destes três métodos.
 */
import type {
  EnrollRequest,
  EnrollResponse,
  IdentifyCandidate,
  IdentifyRequest,
  IdentifyResponse,
  RawSample,
  SessionInitResponse,
  UserSummary,
  VerifyRequest,
  VerifyResponse,
  CaptchaAssessment,
} from './biometrics/contract.js';
import { extractFeatures } from './biometrics/features.js';
import { buildTemplate } from './biometrics/template.js';
import { identify as rankGallery, matchScore } from './biometrics/match.js';
import { decideIdentify, decideVerify } from './biometrics/decision.js';
import type { AppConfig } from './config.js';
import type { Store } from './db/store.js';
import { type CaptchaVerifier, replayedTokenAssessment } from './hcaptcha/verify.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class BiometricService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly captcha: CaptchaVerifier,
  ) {}

  initSession(): SessionInitResponse {
    const session = this.store.createSession(this.config.sessionTtlMs);
    return {
      sessionId: session.sessionId,
      sitekey: this.config.captcha.sitekey,
      rqdata: this.config.captcha.rqdata,
      expiresAt: session.expiresAt,
      captchaMode: this.config.captcha.mode,
    };
  }

  /** Valida o token hCaptcha (com proteção antirreplay opcional). */
  private async assessCaptcha(token: string, remoteIp?: string): Promise<CaptchaAssessment> {
    if (this.config.captcha.enforceSingleUse && this.store.isTokenUsed(token)) {
      return replayedTokenAssessment(this.config);
    }
    const assessment = await this.captcha.verify(token, remoteIp);
    if (assessment.success && this.config.captcha.enforceSingleUse) {
      this.store.markTokenUsed(token);
    }
    return assessment;
  }

  /** Consome o sessionId da captura; lança 400 se inválido. */
  private consumeSession(sample: RawSample): void {
    const result = this.store.consumeSession(sample.sessionId);
    if (!result.ok) {
      throw new HttpError(
        400,
        result.reason,
        'sessionId de captura inválido, expirado ou já utilizado. Chame POST /v1/sessions/init.',
      );
    }
  }

  async enroll(request: EnrollRequest, remoteIp?: string): Promise<EnrollResponse> {
    const captcha = await this.assessCaptcha(request.captchaToken, remoteIp);
    if (!captcha.success) {
      throw new HttpError(403, 'captcha_rejected', 'Token hCaptcha inválido ou já utilizado.', {
        captcha,
      });
    }
    if (captcha.riskBand === 'high') {
      // não se cadastra o comportamento de quem o hCaptcha já classifica como ameaça
      throw new HttpError(
        403,
        'captcha_high_risk',
        `Risco hCaptcha alto (${captcha.risk.toFixed(2)}); cadastro bloqueado.`,
        { captcha },
      );
    }

    const { vector, quality } = extractFeatures(request.sample);
    this.consumeSession(request.sample);

    const user = this.store.ensureUser(request.userId, request.displayName ?? null);

    if (!quality.ok) {
      this.store.appendEvent({
        kind: 'enroll',
        userId: user.userId,
        decision: 'rejected',
        similarity: null,
        risk: captcha.risk,
        reasons: ['low_capture_quality'],
        detail: { issues: quality.issues },
      });
      return {
        userId: user.userId,
        displayName: user.displayName,
        samplesAccepted: user.samples.length,
        samplesRequired: this.config.enrollment.samplesRequired,
        enrolled: user.template != null,
        quality,
        captcha,
        rejected: {
          reason: 'low_capture_quality',
          details: quality.issues,
        },
      };
    }

    this.store.addSample(user.userId, { task: request.sample.task, vector, quality });
    this.store.trimSamples(user.userId, this.config.enrollment.maxSamples);

    const fresh = this.store.getUser(user.userId)!;
    const enrolled = fresh.samples.length >= this.config.enrollment.samplesRequired;
    if (enrolled) {
      this.store.setTemplate(
        user.userId,
        buildTemplate(fresh.samples.map((s) => s.vector)),
      );
    }

    this.store.appendEvent({
      kind: 'enroll',
      userId: user.userId,
      decision: enrolled ? 'enrolled' : 'accepted',
      similarity: null,
      risk: captcha.risk,
      reasons: [],
      detail: { samples: fresh.samples.length, task: request.sample.task },
    });

    return {
      userId: user.userId,
      displayName: fresh.displayName,
      samplesAccepted: fresh.samples.length,
      samplesRequired: this.config.enrollment.samplesRequired,
      enrolled,
      quality,
      captcha,
    };
  }

  async verify(request: VerifyRequest, remoteIp?: string): Promise<VerifyResponse> {
    const started = Date.now();
    const user = this.store.getUser(request.userId);
    if (!user) {
      throw new HttpError(404, 'user_not_found', `Usuário ${request.userId} não cadastrado.`);
    }

    const captcha = await this.assessCaptcha(request.captchaToken, remoteIp);
    const { vector, quality } = extractFeatures(request.sample);
    if (captcha.success) this.consumeSession(request.sample);

    if (!user.template) {
      const response: VerifyResponse = {
        userId: user.userId,
        decision: 'deny',
        reasons: ['not_enrolled'],
        match: emptyMatch(),
        threshold: this.config.policy.baseThreshold,
        quality,
        captcha,
        latencyMs: Date.now() - started,
      };
      this.store.appendEvent({
        kind: 'verify',
        userId: user.userId,
        decision: 'deny',
        similarity: null,
        risk: captcha.risk,
        reasons: response.reasons,
      });
      return response;
    }

    const match = matchScore(user.template, vector, this.store.corpusStats(), this.config.match);
    const { decision, reasons, threshold } = decideVerify({
      match,
      quality,
      captcha,
      policy: this.config.policy,
    });

    if (
      decision === 'allow' &&
      this.config.enrollment.adaptOnAllow &&
      quality.ok &&
      match != null &&
      match.similarity >= threshold + 0.1
    ) {
      // aprendizado incremental: reforça o template com capturas claramente genuínas
      this.store.addSample(user.userId, { task: request.sample.task, vector, quality });
      this.store.trimSamples(user.userId, this.config.enrollment.maxSamples);
      const updated = this.store.getUser(user.userId)!;
      this.store.setTemplate(user.userId, buildTemplate(updated.samples.map((s) => s.vector)));
    }

    this.store.appendEvent({
      kind: 'verify',
      userId: user.userId,
      decision,
      similarity: match?.similarity ?? null,
      risk: captcha.risk,
      reasons,
      detail: { distance: match?.distance ?? null, threshold },
    });

    return {
      userId: user.userId,
      decision,
      reasons,
      match: match ?? emptyMatch(),
      threshold,
      quality,
      captcha,
      latencyMs: Date.now() - started,
    };
  }

  async identify(request: IdentifyRequest, remoteIp?: string): Promise<IdentifyResponse> {
    const started = Date.now();
    const captcha = await this.assessCaptcha(request.captchaToken, remoteIp);
    const { vector, quality } = extractFeatures(request.sample);
    if (captcha.success) this.consumeSession(request.sample);

    const gallery = this.store.gallery().map((user) => ({
      userId: user.userId,
      displayName: user.displayName,
      template: user.template!,
    }));

    const ranked = rankGallery(gallery, vector, this.store.corpusStats(), this.config.match);
    const { decision, reasons, threshold, matchedUserId, margin } = decideIdentify({
      ranked: ranked.map((r) => ({ userId: r.userId, match: r.match })),
      quality,
      captcha,
      policy: this.config.policy,
    });

    const topK = Math.min(Math.max(request.topK ?? 5, 1), 25);
    const candidates: IdentifyCandidate[] = ranked.slice(0, topK).map((entry, index) => ({
      userId: entry.userId,
      displayName: entry.displayName,
      rank: index + 1,
      match: entry.match,
    }));

    this.store.appendEvent({
      kind: 'identify',
      userId: matchedUserId,
      decision,
      similarity: ranked[0]?.match.similarity ?? null,
      risk: captcha.risk,
      reasons,
      detail: { gallerySize: gallery.length, margin, threshold },
    });

    return {
      decision,
      reasons,
      matchedUserId,
      candidates,
      margin,
      threshold,
      requiredMargin: this.config.policy.identifyMargin,
      quality,
      captcha,
      latencyMs: Date.now() - started,
    };
  }

  listUsers(): UserSummary[] {
    return this.store.listUsers().map((user) => ({
      userId: user.userId,
      displayName: user.displayName,
      samples: user.samples.length,
      enrolled: user.template != null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
  }

  deleteUser(userId: string): void {
    if (!this.store.deleteUser(userId)) {
      throw new HttpError(404, 'user_not_found', `Usuário ${userId} não encontrado.`);
    }
  }
}

function emptyMatch() {
  return {
    // valor finito de propósito: Infinity vira null no JSON
    distance: 99,
    similarity: 0,
    perGroup: {},
    topContributors: [],
    dimensionsCompared: 0,
  };
}
