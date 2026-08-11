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
const { app } = createApp({ config });

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
