/**
 * Simulador end-to-end da PoC.
 *
 * Sobe a API em memória (ou aponta para uma já rodando), cadastra pessoas
 * sintéticas e mede o que importa num sistema biométrico:
 *   - 1:1  -> FAR / FRR / EER / d'
 *   - 1:N  -> acerto em rank-1 e rejeição de quem não está na galeria
 *   - fusão com o risco do hCaptcha (step-up adaptativo)
 *
 * Uso:  npm run simulate -- --users 15 --enroll 5 --genuine 4 --impostor 200
 */
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { JsonStore } from '../db/json.js';
import type {
  EnrollResponse,
  IdentifyResponse,
  RawSample,
  SessionInitResponse,
  VerifyResponse,
} from '../biometrics/contract.js';
import { pct, scoreMetrics, suggestCalibration } from './metrics.js';
import { generateSample, makeBotProfile, makeProfile, makeRng, type BehaviorProfile } from './synth.js';

interface Options {
  users: number;
  enroll: number;
  genuine: number;
  impostor: number;
  seed: number;
  api: string | null;
  apiKey: string | null;
  json: string | null;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    users: 15,
    enroll: 5,
    genuine: 4,
    impostor: 240,
    seed: 20260811,
    api: null,
    apiKey: null,
    json: null,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split('=');
    const value = inlineValue ?? argv[i + 1];
    const consume = () => {
      if (inlineValue == null) i++;
      return value;
    };
    switch (flag) {
      case '--users':
        options.users = Number(consume());
        break;
      case '--enroll':
        options.enroll = Number(consume());
        break;
      case '--genuine':
        options.genuine = Number(consume());
        break;
      case '--impostor':
        options.impostor = Number(consume());
        break;
      case '--seed':
        options.seed = Number(consume());
        break;
      case '--api':
        options.api = consume();
        break;
      case '--api-key':
        options.apiKey = consume();
        break;
      case '--json':
        options.json = consume();
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--help':
        console.log(
          'flags: --users --enroll --genuine --impostor --seed --api <url> --api-key <chave> --json <arquivo> --quiet',
        );
        process.exit(0);
    }
  }
  return options;
}

class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null = null,
  ) {}

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 400)}`);
    }
    return JSON.parse(text) as T;
  }

  session(): Promise<SessionInitResponse> {
    return this.call<SessionInitResponse>('/v1/sessions/init', {});
  }

  enroll(userId: string, displayName: string, sample: RawSample, token: string) {
    return this.call<EnrollResponse>('/v1/enroll', {
      userId,
      displayName,
      captchaToken: token,
      sample,
    });
  }

  verify(userId: string, sample: RawSample, token: string) {
    return this.call<VerifyResponse>('/v1/verify', { userId, captchaToken: token, sample });
  }

  identify(sample: RawSample, token: string, topK = 3) {
    return this.call<IdentifyResponse>('/v1/identify', { captchaToken: token, sample, topK });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rng = makeRng(options.seed);

  let baseUrl = options.api;
  let close: (() => Promise<void>) | null = null;
  const config = loadConfig({
    ...process.env,
    HCAPTCHA_MODE: 'mock',
    DATA_FILE: 'memory',
  });

  if (!baseUrl) {
    const { app } = createApp({ config, store: new JsonStore(null) });
    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const api = new ApiClient(baseUrl, options.apiKey);
  const log = options.quiet ? () => {} : (msg: string) => console.log(msg);

  log(`\n=== Simulador PoC hCaptcha + biometria comportamental ===`);
  log(`API ................ ${baseUrl}${options.api ? ' (externa)' : ' (em memória)'}`);
  log(`seed ............... ${options.seed}`);
  log(
    `pessoas ............ ${options.users} (cadastro: ${options.enroll} amostras cada)\n`,
  );

  // ---- perfis ------------------------------------------------------------
  const profiles: BehaviorProfile[] = [];
  for (let i = 0; i < options.users; i++) {
    profiles.push(makeProfile(`user-${String(i + 1).padStart(2, '0')}`, rng));
  }
  // pessoas fora da galeria, para medir rejeição em 1:N (open-set)
  const outsiders: BehaviorProfile[] = [];
  for (let i = 0; i < Math.max(6, Math.round(options.users / 2)); i++) {
    outsiders.push(makeProfile(`outsider-${i + 1}`, rng));
  }
  const bot = makeBotProfile('bot-01');

  const fresh = async (profile: BehaviorProfile, task: string, variability = 1) => {
    const session = await api.session();
    return generateSample(profile, rng, { sessionId: session.sessionId, task, variability });
  };

  // ---- cadastro ----------------------------------------------------------
  let enrolledCount = 0;
  let rejectedSamples = 0;
  for (const profile of profiles) {
    for (let k = 0; k < options.enroll; k++) {
      const sample = await fresh(profile, `enroll-${k + 1}`);
      const result = await api.enroll(profile.id, `Pessoa ${profile.id}`, sample, 'mock:0.1');
      if (result.rejected) rejectedSamples++;
      if (result.enrolled && k === options.enroll - 1) enrolledCount++;
    }
  }
  log(`cadastro ........... ${enrolledCount}/${options.users} com template pronto`);
  if (rejectedSamples > 0) log(`  amostras recusadas por qualidade: ${rejectedSamples}`);

  // ---- 1:1 genuíno -------------------------------------------------------
  const genuineScores: number[] = [];
  const genuineDistances: number[] = [];
  const genuineDecisions = { allow: 0, step_up: 0, deny: 0 };
  for (const profile of profiles) {
    for (let g = 0; g < options.genuine; g++) {
      const sample = await fresh(profile, 'verify-genuino');
      const result = await api.verify(profile.id, sample, 'mock:0.1');
      genuineScores.push(result.match.similarity);
      genuineDistances.push(result.match.distance);
      genuineDecisions[result.decision]++;
    }
  }

  // ---- 1:1 impostor ------------------------------------------------------
  const impostorScores: number[] = [];
  const impostorDistances: number[] = [];
  const impostorDecisions = { allow: 0, step_up: 0, deny: 0 };
  for (let i = 0; i < options.impostor; i++) {
    const attacker = rng.pick(profiles);
    let victim = rng.pick(profiles);
    while (victim.id === attacker.id) victim = rng.pick(profiles);
    const sample = await fresh(attacker, 'verify-impostor');
    const result = await api.verify(victim.id, sample, 'mock:0.1');
    impostorScores.push(result.match.similarity);
    impostorDistances.push(result.match.distance);
    impostorDecisions[result.decision]++;
  }

  const operating = config.policy.baseThreshold + config.policy.riskAdjust.low;
  const oneToOne = scoreMetrics(genuineScores, impostorScores, operating);
  const distances = scoreMetrics(
    impostorDistances.map((d) => -d),
    genuineDistances.map((d) => -d),
    0,
  );
  const suggestion = suggestCalibration(genuineDistances, impostorDistances);

  // ---- 1:1 robô ----------------------------------------------------------
  const botScores: number[] = [];
  const botDecisions = { allow: 0, step_up: 0, deny: 0 };
  for (const profile of profiles.slice(0, Math.min(8, profiles.length))) {
    const sample = await fresh(bot, 'verify-bot');
    const result = await api.verify(profile.id, sample, 'mock:0.1');
    botScores.push(result.match.similarity);
    botDecisions[result.decision]++;
  }

  // ---- 1:N ---------------------------------------------------------------
  let rank1 = 0;
  let inTop3 = 0;
  let allowedCorrect = 0;
  let allowedWrong = 0;
  const identifyMargins: number[] = [];
  for (const profile of profiles) {
    const sample = await fresh(profile, 'identify-genuino');
    const result = await api.identify(sample, 'mock:0.1', 3);
    if (result.candidates[0]?.userId === profile.id) rank1++;
    if (result.candidates.some((c) => c.userId === profile.id)) inTop3++;
    if (result.margin != null) identifyMargins.push(result.margin);
    if (result.decision === 'allow') {
      if (result.matchedUserId === profile.id) allowedCorrect++;
      else allowedWrong++;
    }
  }

  // ---- 1:N open-set (quem não está cadastrado) ---------------------------
  let outsiderAccepted = 0;
  for (const profile of outsiders) {
    const sample = await fresh(profile, 'identify-outsider');
    const result = await api.identify(sample, 'mock:0.1', 3);
    if (result.decision === 'allow') outsiderAccepted++;
  }

  // ---- fusão com o risco do hCaptcha -------------------------------------
  const fusion: Array<{ risco: number; decision: string; threshold: number; sim: number }> = [];
  const fusionProfile = profiles[0];
  for (const risk of [0.05, 0.5, 0.85]) {
    const sample = await fresh(fusionProfile, 'verify-fusao');
    const result = await api.verify(fusionProfile.id, sample, `mock:${risk}`);
    fusion.push({
      risco: risk,
      decision: result.decision,
      threshold: result.threshold,
      sim: result.match.similarity,
    });
  }
  const invalidSession = await (async () => {
    const sample = await fresh(fusionProfile, 'verify-captcha-invalido');
    return api.verify(fusionProfile.id, sample, 'mock:fail');
  })();

  // ---- relatório ---------------------------------------------------------
  log(`\n--- 1:1 (verificação) -------------------------------------------`);
  log(`limiar operacional . ${operating.toFixed(3)} (base ${config.policy.baseThreshold} em risco baixo)`);
  log(
    `genuínos ........... n=${oneToOne.genuine.n} sim=${oneToOne.genuine.mean}±${oneToOne.genuine.std} [${oneToOne.genuine.min}..${oneToOne.genuine.max}]`,
  );
  log(
    `impostores ......... n=${oneToOne.impostor.n} sim=${oneToOne.impostor.mean}±${oneToOne.impostor.std} [${oneToOne.impostor.min}..${oneToOne.impostor.max}]`,
  );
  log(`d' (separação) ..... ${oneToOne.dPrime}`);
  log(`EER ................ ${pct(oneToOne.eer)} (limiar ${oneToOne.eerThreshold})`);
  log(
    `no limiar .......... FAR ${pct(oneToOne.atThreshold.far)} | FRR ${pct(oneToOne.atThreshold.frr)}`,
  );
  log(`FRR @ FAR<=1% ...... ${pct(oneToOne.frrAtFar1)}`);
  log(
    `distância genuína .. ${(-distances.impostor.mean).toFixed(3)} | impostora ${(-distances.genuine.mean).toFixed(3)}`,
  );
  if (suggestion) {
    log(
      `calibração sugerida  MATCH_MIDPOINT=${suggestion.calibrationMidpoint} MATCH_STEEPNESS=${suggestion.calibrationSteepness}` +
        ` (em uso: ${config.match.calibrationMidpoint} / ${config.match.calibrationSteepness})`,
    );
  }
  log(
    `decisões genuíno ... allow ${genuineDecisions.allow} | step_up ${genuineDecisions.step_up} | deny ${genuineDecisions.deny}`,
  );
  log(
    `decisões impostor .. allow ${impostorDecisions.allow} | step_up ${impostorDecisions.step_up} | deny ${impostorDecisions.deny}`,
  );

  log(`\n--- robô contra template humano ---------------------------------`);
  log(
    `similaridade média . ${botScores.length ? (botScores.reduce((a, b) => a + b, 0) / botScores.length).toFixed(4) : 'n/d'}`,
  );
  log(
    `decisões ........... allow ${botDecisions.allow} | step_up ${botDecisions.step_up} | deny ${botDecisions.deny}`,
  );

  log(`\n--- 1:N (identificação) -----------------------------------------`);
  log(`galeria ............ ${profiles.length} pessoas`);
  log(`acerto rank-1 ...... ${rank1}/${profiles.length} (${pct(rank1 / profiles.length)})`);
  log(`presente no top-3 .. ${inTop3}/${profiles.length}`);
  log(`allow correto ...... ${allowedCorrect} | allow no usuário errado ${allowedWrong}`);
  log(
    `margem 1º-2º ....... média ${
      identifyMargins.length
        ? (identifyMargins.reduce((a, b) => a + b, 0) / identifyMargins.length).toFixed(4)
        : 'n/d'
    } (mínima exigida ${config.policy.identifyMargin})`,
  );
  log(
    `fora da galeria .... ${outsiderAccepted}/${outsiders.length} aceitos por engano (FPIR ${pct(outsiderAccepted / outsiders.length)})`,
  );

  log(`\n--- fusão com risco hCaptcha ------------------------------------`);
  for (const row of fusion) {
    log(
      `risco ${row.risco.toFixed(2)} -> limiar ${row.threshold.toFixed(3)} | sim ${row.sim.toFixed(3)} | ${row.decision}`,
    );
  }
  log(`token inválido ..... ${invalidSession.decision} (${invalidSession.reasons.join(', ')})`);
  log('');

  if (options.json) {
    writeFileSync(
      options.json,
      JSON.stringify(
        {
          options,
          operatingThreshold: operating,
          oneToOne: { ...oneToOne, roc: undefined },
          suggestedCalibration: suggestion,
          decisions: { genuine: genuineDecisions, impostor: impostorDecisions, bot: botDecisions },
          identification: {
            gallery: profiles.length,
            rank1,
            rank1Rate: rank1 / profiles.length,
            inTop3,
            allowedCorrect,
            allowedWrong,
            outsiderAccepted,
            outsiders: outsiders.length,
          },
          fusion,
        },
        null,
        2,
      ),
      'utf8',
    );
    log(`métricas gravadas em ${options.json}\n`);
  }

  if (close) await close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
