import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';
import { HCAPTCHA_TEST_SITEKEY, loadConfig } from './config.js';

// .env é opcional: sem ele o servidor sobe com as chaves públicas de teste
try {
  process.loadEnvFile('.env');
} catch {
  // arquivo ausente — segue com os defaults
}

const config = loadConfig();

let bundle: ReturnType<typeof createApp>;
try {
  bundle = createApp({ config });
} catch (error) {
  // chave malformada é erro de configuração: falhar no boot é melhor que
  // descobrir na primeira gravação, com dados já em memória
  console.error(`\n  [erro de configuração] ${(error as Error).message}\n`);
  process.exit(1);
}
const { app, auth, encryptionEnabled } = bundle;

const server = app.listen(config.port, config.host, () => {
  const lanIp =
    Object.values(networkInterfaces())
      .flat()
      .find((iface) => iface && iface.family === 'IPv4' && !iface.internal)?.address ?? '127.0.0.1';

  console.log(`\n  PoC hCaptcha + biometria comportamental`);
  console.log(`  API  ........ http://${lanIp}:${config.port}`);
  console.log(`  modo hCaptcha ${config.captcha.mode}`);
  console.log(`  sitekey ..... ${config.captcha.sitekey}`);
  console.log(`  storage ..... ${config.dataFile ?? 'memória'}`);
  console.log(`  amostras p/ cadastro: ${config.enrollment.samplesRequired}`);
  console.log(
    `  autenticação  ${auth.enabled ? `${auth.keyHashes.length} chave(s) de API` : 'ABERTA'}`,
  );
  console.log(`  cifra em repouso ${encryptionEnabled ? 'AES-256-GCM' : 'DESLIGADA'}`);

  if (!auth.enabled) {
    console.log(
      `\n  [aviso] a API está ABERTA: qualquer um na mesma rede cadastra, verifica e\n` +
        `          lista pessoas. Defina API_KEYS para fechar (openssl rand -hex 24).`,
    );
  }
  if (!encryptionEnabled && config.dataFile) {
    console.log(
      `\n  [aviso] templates biométricos gravados EM CLARO em ${config.dataFile}.\n` +
        `          Dado biométrico é sensível na LGPD e não se "reseta" como senha.\n` +
        `          Defina TEMPLATE_ENCRYPTION_KEY (openssl rand -base64 32).`,
    );
  }
  if (config.captcha.sitekey === HCAPTCHA_TEST_SITEKEY) {
    console.log(
      `\n  [aviso] usando o sitekey PÚBLICO de teste do hCaptcha: nunca desafia e\n` +
        `          não devolve risco (score). Para exercitar biometria comportamental\n` +
        `          de verdade use um sitekey Enterprise Passive/Invisible.`,
    );
  }
  console.log(`\n  No app mobile aponte EXPO_PUBLIC_API_URL para http://${lanIp}:${config.port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
