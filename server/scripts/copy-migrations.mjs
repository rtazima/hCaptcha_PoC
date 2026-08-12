#!/usr/bin/env node
/**
 * Copia os .sql de migração para dist/.
 *
 * O tsc só emite arquivos TypeScript, então sem este passo o build compilado
 * sobe sem as migrações e falha ao tentar migrar — bug que não aparece em dev,
 * onde o tsx roda direto de src/.
 *
 * Usa fs.cpSync em vez de `cp -r` para funcionar também no Windows.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../src/db/migrations');
const target = resolve(here, '../dist/db/migrations');

if (!existsSync(source)) {
  console.error(`origem das migrações não encontrada: ${source}`);
  process.exit(1);
}

cpSync(source, target, { recursive: true });
const copied = readdirSync(target).filter((f) => f.endsWith('.sql'));
if (copied.length === 0) {
  console.error('nenhum .sql copiado — o build ficaria sem migrações');
  process.exit(1);
}
console.log(`migrações copiadas para dist/: ${copied.join(', ')}`);
