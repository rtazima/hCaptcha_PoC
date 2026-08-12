/**
 * Entrada serverless da API (Vercel Functions).
 *
 * Função catch-all: tudo em `/api/*` cai aqui. O prefixo `/api` é removido antes
 * de entregar ao Express, então as rotas continuam sendo `/v1/...` e `/healthz` —
 * o mesmo código serve tanto o `npm run dev` quanto a Vercel, sem duplicar
 * roteamento.
 *
 * O app e o store são criados **uma vez por instância** (escopo de módulo) e
 * reusados entre invocações. Criar por requisição abriria um pool de Postgres
 * novo a cada chamada e esgotaria as conexões do banco em minutos.
 *
 * Requer `DATABASE_URL`: em serverless o disco é efêmero e `createStore` recusa
 * subir com armazenamento em arquivo, de propósito.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/app.js';
import { createStore } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();

/**
 * Uma única promise no escopo do módulo. Invocações concorrentes na mesma
 * instância aguardam a mesma inicialização em vez de disputar migrações.
 */
const ready = (async () => {
  const store = await createStore(config);
  return createApp({ config, store }).app;
})();

// erro de configuração aqui é fatal e precisa aparecer no log da função
ready.catch((error) => {
  console.error('[boot] falha ao inicializar a API:', (error as Error).message);
});

export default async function handler(
  req: IncomingMessage & { url?: string },
  res: ServerResponse,
): Promise<void> {
  let app: Awaited<typeof ready>;
  try {
    app = await ready;
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'boot_error',
        message: (error as Error).message,
      }),
    );
    return;
  }

  // "/api/v1/enroll" -> "/v1/enroll"; "/api" -> "/"
  if (req.url) req.url = req.url.replace(/^\/api(?=\/|$)/, '') || '/';

  // o Express é um handler (req, res) comum
  (app as unknown as (a: IncomingMessage, b: ServerResponse) => void)(req, res);
}
