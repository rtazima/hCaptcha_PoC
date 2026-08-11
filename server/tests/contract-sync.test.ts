import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const serverContract = resolve(here, '../src/biometrics/contract.ts');
const mobileContract = resolve(here, '../../mobile/src/api/contract.ts');

describe('contrato compartilhado', () => {
  it('a cópia do app mobile é idêntica à do servidor', () => {
    const server = readFileSync(serverContract, 'utf8');
    let mobile: string;
    try {
      mobile = readFileSync(mobileContract, 'utf8');
    } catch {
      throw new Error('mobile/src/api/contract.ts não existe — rode `npm run sync:contract`');
    }
    expect(mobile, 'contratos divergiram — rode `npm run sync:contract`').toBe(server);
  });

  it('o contrato não importa nada (para poder ser copiado como está)', () => {
    const server = readFileSync(serverContract, 'utf8');
    expect(server).not.toMatch(/^\s*import\s/m);
  });
});
