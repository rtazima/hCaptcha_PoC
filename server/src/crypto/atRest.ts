/**
 * Cifra dos campos biométricos em repouso (AES-256-GCM).
 *
 * Por que só os campos biométricos e não o arquivo inteiro: a PoC precisa
 * continuar inspecionável (`cat data/db.json` mostra quem existe, quantas
 * amostras, a auditoria) enquanto o que identifica a pessoa — vetor de features
 * e template — fica ilegível sem a chave.
 *
 * Não se "reseta" um template comportamental: senha vazada se troca, jeito de
 * digitar não. Por isso cifra em repouso é o primeiro item para sair do
 * laboratório, e não um detalhe de produção.
 *
 * Formato: "v1.<iv b64url>.<tag b64url>.<ciphertext b64url>"
 * GCM já autentica: adulterar o arquivo faz `open` lançar em vez de devolver
 * dado silenciosamente corrompido.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // recomendado para GCM
const KEY_BYTES = 32;
const PREFIX = 'v1';

export class CryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoConfigError';
  }
}

export class SealedDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedDataError';
  }
}

export interface Sealer {
  /** true quando há chave configurada; false = grava em claro */
  readonly enabled: boolean;
  /** Cifra um valor serializável. */
  seal(value: unknown): string;
  /** Decifra e devolve o valor. Lança se a chave estiver errada ou o dado adulterado. */
  open<T>(sealed: string): T;
}

/** Detecta se uma string está no formato produzido por `seal`. */
export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${PREFIX}.`);
}

/**
 * Interpreta a chave: base64 (44 chars) ou hex (64 chars) de 32 bytes.
 * Chave curta é erro de configuração, não algo a "esticar" silenciosamente —
 * derivar chave de senha fraca daria falsa sensação de segurança.
 */
export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) candidates.push(Buffer.from(trimmed, 'hex'));
  else candidates.push(Buffer.from(trimmed, 'base64'));

  const key = candidates[0];
  if (key.length !== KEY_BYTES) {
    throw new CryptoConfigError(
      `a chave de cifra precisa ter ${KEY_BYTES} bytes (base64 ou hex); ` +
        `a fornecida tem ${key.length}. Gere uma com: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Sealer inerte: grava em claro. Usado quando não há chave configurada. */
export function createNullSealer(): Sealer {
  return {
    enabled: false,
    seal: () => {
      throw new CryptoConfigError('seal() chamado sem chave de cifra configurada');
    },
    open: () => {
      throw new CryptoConfigError(
        'há dados cifrados no arquivo, mas nenhuma chave configurada. ' +
          'Defina TEMPLATE_ENCRYPTION_KEY com a mesma chave usada para gravar.',
      );
    },
  };
}

export function createSealer(rawKey: string | null | undefined): Sealer {
  if (!rawKey || rawKey.trim() === '') return createNullSealer();
  const key = parseKey(rawKey);

  return {
    enabled: true,

    seal(value: unknown): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [PREFIX, b64(iv), b64(tag), b64(ciphertext)].join('.');
    },

    open<T>(sealed: string): T {
      const parts = sealed.split('.');
      if (parts.length !== 4 || parts[0] !== PREFIX) {
        throw new SealedDataError(`formato de dado cifrado desconhecido: ${parts[0]}`);
      }
      const [, ivPart, tagPart, ctPart] = parts;
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv(ALGORITHM, key, unb64(ivPart));
        decipher.setAuthTag(unb64(tagPart));
        plaintext = Buffer.concat([decipher.update(unb64(ctPart)), decipher.final()]);
      } catch (error) {
        // GCM falha na verificação da tag: chave errada OU arquivo adulterado.
        // Não há como distinguir os dois casos, e é bom que não haja.
        throw new SealedDataError(
          'não foi possível decifrar os dados biométricos: a chave está errada ou ' +
            `o arquivo foi alterado (${(error as Error).message})`,
        );
      }
      return JSON.parse(plaintext.toString('utf8')) as T;
    },
  };
}

/** Comparação em tempo constante entre dois hashes hex do mesmo tamanho. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function unb64(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}
