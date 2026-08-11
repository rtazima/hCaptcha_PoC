/**
 * Runner de migração.
 *
 * São ~40 linhas em vez de uma dependência: aplica os `.sql` de `migrations/`
 * em ordem, cada um numa transação, e registra o que já rodou. O ativo aqui é o
 * SQL, que se porta para qualquer ferramenta de migração que vocês já usem
 * (Flyway, node-pg-migrate, Prisma) — o runner é descartável.
 *
 * Um `advisory lock` evita que duas instâncias subindo ao mesmo tempo apliquem
 * a mesma migração em paralelo.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
/** número arbitrário mas estável, só precisa não colidir com outros locks */
const LOCK_ID = 828_713_001;

export interface AppliedMigration {
  name: string;
  alreadyApplied: boolean;
}

export function listMigrationFiles(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<AppliedMigration[]> {
  const client = await pool.connect();
  const results: AppliedMigration[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );

    for (const name of listMigrationFiles(dir)) {
      if (applied.has(name)) {
        results.push({ name, alreadyApplied: true });
        continue;
      }
      const sql = readFileSync(join(dir, name), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`migração ${name} falhou: ${(error as Error).message}`);
      }
      results.push({ name, alreadyApplied: false });
    }
    return results;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}
