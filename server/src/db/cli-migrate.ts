/**
 * Aplica as migrações e sai. `npm run db:migrate`
 *
 * O servidor já migra no boot, mas um comando separado é o que pipelines de
 * deploy precisam: migrar antes de trocar as instâncias, não durante.
 */
import { Pool } from 'pg';
import { migrate } from './migrate.js';

try {
  process.loadEnvFile('.env');
} catch {
  // sem .env: usa o ambiente como está
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error('DATABASE_URL não definido — nada a migrar (o modo arquivo não usa migração).');
  process.exit(1);
}

const pool = new Pool({ connectionString });
try {
  const applied = await migrate(pool);
  const novas = applied.filter((m) => !m.alreadyApplied);
  for (const m of applied) {
    console.log(`  ${m.alreadyApplied ? 'já aplicada' : 'APLICADA   '}  ${m.name}`);
  }
  console.log(`\n${novas.length} migração(ões) nova(s), ${applied.length} no total.`);
} catch (error) {
  console.error(`\nfalha na migração: ${(error as Error).message}`);
  process.exit(1);
} finally {
  await pool.end();
}
