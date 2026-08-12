/**
 * Autenticação da API por chave.
 *
 * Deliberadamente simples: a PoC não tem usuários finais, tem *sistemas* que
 * chamam a API (o app e o simulador). Chave estática em header resolve, sem
 * arrastar OAuth/JWT para dentro de uma prova de conceito. O ponto de troca é
 * este arquivo — encaixar o esquema de vocês significa reescrever só ele.
 *
 * Sem chave configurada a API continua aberta, com aviso no boot. Fechar por
 * padrão quebraria o fluxo de demo que o README descreve; o que não se pode é
 * fechar silenciosamente e deixar a pessoa achar que está protegida.
 */
import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { constantTimeEquals } from './crypto/atRest.js';

export interface AuthConfig {
  /** hashes SHA-256 das chaves aceitas (a chave em claro nunca é guardada) */
  keyHashes: string[];
  /** true quando há ao menos uma chave configurada */
  enabled: boolean;
  /** rotas liberadas mesmo com autenticação ligada */
  publicPaths: string[];
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key.trim(), 'utf8').digest('hex');
}

/** Chaves curtas dariam falsa sensação de segurança — 16 chars é o piso. */
export const MIN_KEY_LENGTH = 16;

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export function buildAuthConfig(rawKeys: string[], publicPaths = ['/healthz']): AuthConfig {
  const keys = rawKeys.map((k) => k.trim()).filter((k) => k.length > 0);
  for (const key of keys) {
    if (key.length < MIN_KEY_LENGTH) {
      throw new AuthConfigError(
        `chave de API curta demais (${key.length} caracteres, mínimo ${MIN_KEY_LENGTH}). ` +
          'Gere uma com: openssl rand -hex 24',
      );
    }
  }
  return {
    keyHashes: keys.map(hashKey),
    enabled: keys.length > 0,
    publicPaths,
  };
}

/** Extrai a chave de `Authorization: Bearer <chave>` ou do header `x-api-key`. */
export function extractKey(req: Request): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();
  return null;
}

export function isAuthorized(auth: AuthConfig, presentedKey: string | null): boolean {
  if (!auth.enabled) return true;
  if (!presentedKey) return false;
  const presented = hashKey(presentedKey);
  // percorre todas as chaves: sair no primeiro acerto vazaria, pelo tempo,
  // a posição da chave válida na lista
  let matched = false;
  for (const known of auth.keyHashes) {
    if (constantTimeEquals(known, presented)) matched = true;
  }
  return matched;
}

export function apiKeyAuth(auth: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!auth.enabled || auth.publicPaths.includes(req.path)) {
      next();
      return;
    }
    if (isAuthorized(auth, extractKey(req))) {
      next();
      return;
    }
    res.status(401).json({
      error: 'unauthorized',
      message: 'Envie a chave da API em "Authorization: Bearer <chave>" ou no header x-api-key.',
    });
  };
}
