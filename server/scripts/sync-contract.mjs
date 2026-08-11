#!/usr/bin/env node
/**
 * Copia o contrato de dados do servidor para o app mobile.
 * O teste `contract-sync.test.ts` falha se as duas cópias divergirem, então
 * mudar o contrato e esquecer de rodar isto quebra o build — de propósito.
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../src/biometrics/contract.ts');
const target = resolve(here, '../../mobile/src/api/contract.ts');

mkdirSync(dirname(target), { recursive: true });

let before = null;
try {
  before = readFileSync(target, 'utf8');
} catch {
  // primeira cópia
}

copyFileSync(source, target);
const after = readFileSync(target, 'utf8');

if (before === after) {
  console.log('contrato já sincronizado: mobile/src/api/contract.ts');
} else {
  console.log(`contrato copiado -> mobile/src/api/contract.ts (${after.length} bytes)`);
}
