/**
 * Cliente da API da PoC.
 *
 * A URL base vem de EXPO_PUBLIC_API_URL, mas pode ser trocada em execução na
 * tela inicial — num demo o IP da máquina muda toda hora e recompilar o bundle
 * só para isso é fricção desnecessária.
 */
import type {
  EnrollRequest,
  EnrollResponse,
  IdentifyRequest,
  IdentifyResponse,
  SessionInitResponse,
  UserSummary,
  VerifyRequest,
  VerifyResponse,
} from './contract';

const DEFAULT_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';
const DEFAULT_API_KEY = process.env.EXPO_PUBLIC_API_KEY ?? '';

let baseUrl = DEFAULT_BASE_URL;
let apiKey = DEFAULT_API_KEY;

export function getBaseUrl(): string {
  return baseUrl;
}

export function setBaseUrl(url: string): void {
  baseUrl = url.trim().replace(/\/+$/, '');
}

export function resetBaseUrl(): void {
  baseUrl = DEFAULT_BASE_URL;
}

/**
 * Chave da API. Vem de EXPO_PUBLIC_API_KEY, mas pode ser trocada na tela
 * inicial — num demo o backend às vezes sobe fechado depois do app já rodando.
 *
 * Atenção: variável EXPO_PUBLIC_* é embutida no bundle, então esta chave é
 * visível para quem tiver o app. Serve para separar sistemas numa PoC, não
 * para autenticar usuário final.
 */
export function getApiKey(): string {
  return apiKey;
}

export function setApiKey(key: string): void {
  apiKey = key.trim();
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Configuração pública devolvida por GET /v1/config. */
export interface ServerConfig {
  captcha: {
    mode: 'live' | 'test' | 'mock';
    sitekey: string;
    rqdata: string | null;
    enforceSingleUse: boolean;
  };
  enrollment: { samplesRequired: number; maxSamples: number; adaptOnAllow: boolean };
  policy: {
    baseThreshold: number;
    stepUpBand: number;
    riskAdjust: { low: number; medium: number; high: number };
    lowRiskMax: number;
    highRiskMin: number;
    highRiskForcesStepUp: boolean;
    identifyMargin: number;
    identifyThresholdBoost: number;
  };
  match: { calibrationMidpoint: number; calibrationSteepness: number; shrinkage: number };
  features: {
    version: number;
    count: number;
    groups: string[];
    groupWeights: Record<string, number>;
    list: Array<{ name: string; group: string; priorScale: number; about: string }>;
  };
}

export interface AuditEvent {
  eventId: string;
  at: string;
  kind: string;
  userId: string | null;
  decision: string | null;
  similarity: number | null;
  risk: number | null;
  reasons: string[];
}

const TIMEOUT_MS = 20_000;

async function call<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const reason = (error as Error)?.name === 'AbortError' ? 'tempo esgotado' : 'falha de rede';
    throw new ApiError(
      0,
      'network_error',
      `Não foi possível falar com ${baseUrl} (${reason}). ` +
        'Confira se o backend está rodando e se o celular alcança esse IP.',
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, 'invalid_json', `Resposta ilegível: ${text.slice(0, 120)}`);
    }
  }

  if (!response.ok) {
    const error = payload as { error?: string; message?: string; details?: unknown } | null;
    throw new ApiError(
      response.status,
      error?.error ?? 'http_error',
      error?.message ?? `HTTP ${response.status}`,
      error?.details,
    );
  }

  return payload as T;
}

export const api = {
  health: () =>
    call<{
      ok: boolean;
      users: number;
      captchaMode: string;
      authRequired: boolean;
      encryptionAtRest: boolean;
    }>('/healthz', 'GET'),
  config: () => call<ServerConfig>('/v1/config', 'GET'),
  initSession: () => call<SessionInitResponse>('/v1/sessions/init', 'POST', {}),
  enroll: (request: EnrollRequest) => call<EnrollResponse>('/v1/enroll', 'POST', request),
  verify: (request: VerifyRequest) => call<VerifyResponse>('/v1/verify', 'POST', request),
  identify: (request: IdentifyRequest) => call<IdentifyResponse>('/v1/identify', 'POST', request),
  users: () => call<{ users: UserSummary[] }>('/v1/users', 'GET'),
  deleteUser: (userId: string) => call<void>(`/v1/users/${encodeURIComponent(userId)}`, 'DELETE'),
  audit: (limit = 30) => call<{ events: AuditEvent[] }>(`/v1/audit?limit=${limit}`, 'GET'),
};
