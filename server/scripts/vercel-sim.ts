/**
 * Reproduz localmente o que a Vercel faz com o `vercel.json` deste diretório:
 * aplica os rewrites e entrega a requisição ao handler de `api/[...path].ts`.
 *
 * Existe porque o caminho serverless não é o mesmo do `npm run dev`. Ali o
 * Express escuta direto; aqui a URL chega com prefixo `/api`, o app é um
 * singleton de escopo de módulo reusado entre invocações, e o armazenamento em
 * arquivo é proibido. Sem este harness, a primeira vez que esse caminho roda é
 * no deploy — e um erro de configuração vira build vermelho em vez de teste
 * vermelho.
 *
 *   DATABASE_URL=postgres://... npm run dev:serverless
 *
 * Não é um emulador da Vercel: não há bundling, cold start nem limite de
 * duração. O que ele cobre é o contrato de roteamento e o boot.
 */
import { createServer } from 'node:http';
import handler from '../api/[...path].js';

/** Espelha `rewrites` do vercel.json. Mudou lá, muda aqui. */
const REWRITES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^\/healthz(\?.*)?$/, (m) => `/api/healthz${m[1] ?? ''}`],
  [/^\/v1\/(.*)$/, (m) => `/api/v1/${m[1]}`],
];

function rewrite(url: string): string {
  for (const [pattern, to] of REWRITES) {
    const match = url.match(pattern);
    if (match) return to(match);
  }
  // Sem rewrite a Vercel serviria estático e devolveria 404. Aqui repassamos
  // como veio, para que uma rota esquecida apareça como 404 do Express.
  return url;
}

const server = createServer((req, res) => {
  const original = req.url ?? '/';
  req.url = rewrite(original);
  console.log(`${req.method} ${original} -> ${req.url}`);
  void handler(req, res);
});

const port = Number(process.env.SIM_PORT ?? process.env.PORT ?? 8791);
server.listen(port, '127.0.0.1', () => {
  console.log(`[vercel-sim] http://127.0.0.1:${port} (rotas: /healthz, /v1/*)`);
});
