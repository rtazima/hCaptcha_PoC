# Arquitetura

## Pipeline

```
app: eventos crus ──▶ POST /v1/{enroll,verify,identify}
                        │
                        ├─ 1. valida token hCaptcha  (/siteverify + antirreplay)
                        ├─ 2. consome a sessão de captura (nonce de uso único)
                        ├─ 3. extractFeatures()      -> vetor de 45 dimensões + laudo de qualidade
                        ├─ 4. corpusStats()          -> escala e peso por dimensão
                        ├─ 5. matchScore()/identify() -> distância -> similaridade calibrada
                        └─ 6. decide{Verify,Identify} -> allow | step_up | deny + motivos
```

Decisão de projeto que orienta o resto: **o app só coleta eventos crus; toda a inteligência
fica no servidor**. Isso significa (a) uma única implementação de features, versionada e
testada; (b) o simulador exercita exatamente o mesmo código que o app real usa; (c) evoluir o
motor não exige publicar app novo.

## 1. Captura no dispositivo

`mobile/src/capture/recorder.ts` acumula quatro streams:

| stream | o que é gravado | o que **não** é gravado |
|---|---|---|
| digitação | classe da tecla (`char`/`space`/`backspace`/`enter`) + instante | o caractere, o texto, o tamanho do texto |
| arraste | sequência de pontos (x, y normalizados 0..1, t) | nada além da geometria |
| toques | posição normalizada + tempo de pressão | — |
| movimento | acelerômetro (g) e giroscópio (rad/s) a 20 Hz | — |

A tarefa é **fixa e idêntica** em cadastro e verificação (mesma frase, mesma área de arraste,
mesmos alvos). Dinâmica de digitação com texto fixo é substancialmente mais estável que com
texto livre, e comparar capturas equivalentes é o que torna o template comparável.

## 2. Features (45 dimensões, 5 grupos)

`server/src/biometrics/features.ts` é a fonte da verdade — `GET /v1/config` publica o catálogo
inteiro com descrição de cada dimensão.

| grupo | dims | exemplos | peso |
|---|---|---|---|
| `keystroke` | 13 | intervalo médio/mediano/p90 entre teclas, coef. de variação, autocorrelação lag-1 do ritmo, taxa de correção, tamanho das rajadas | 1.0 |
| `gesture` | 16 | velocidade média e de pico, razão pico/média, jerk, curvatura, retidão, desaceleração no fim do traço, latência até iniciar o movimento | 1.0 |
| `tap` | 4 | tempo de pressão (média e variação), intervalo entre toques | 0.6 |
| `motion` | 8 | desvio da gravidade, magnitude do giro, inclinação/rotação médias, estabilidade da postura | 0.8 |
| `session` | 4 | latência até a 1ª interação, duração, densidade de eventos | 0.4 |

Três escolhas que importam:

- **Valores em log** onde a distribuição é assimétrica (tempos, contagens). Sem isso, um único
  intervalo de 3 segundos domina a média.
- **`null` é um valor de primeira classe.** Faltou digitação? As 13 dimensões do grupo ficam
  nulas e o matching compara **só o que existe nos dois lados**, em vez de imputar zero (o que
  seria interpretado como "digitou instantaneamente").
- **Fusão em nível de grupo**: a distância final pondera *grupos*, não dimensões. Assim
  acrescentar 10 features de gesto não faz o grupo `gesture` pesar mais na decisão.

## 3. Estatística do corpus e peso por discriminabilidade

`computeCorpusStats()` roda sobre todas as amostras conhecidas, **agrupadas por pessoa**, e
produz por dimensão:

- **escala** (denominador do z-score): dispersão robusta populacional (MAD × 1.4826, com IQR
  como reserva), misturada com um *prior* por 10 amostras equivalentes — sem isso o sistema não
  funcionaria com o primeiro usuário cadastrado.
- **peso de discriminabilidade**: `1 − (dispersão intra-pessoa)² / (dispersão entre pessoas)²`,
  limitado a `0.05..1`.

O peso é a parte que mais mexeu na acurácia. Uma dimensão que varia tanto de uma captura para
outra quanto de uma pessoa para outra (a *quantidade* de eventos, por exemplo, que depende mais
da tarefa que do dedo) recebe peso baixo **automaticamente**, sem alguém chutar pesos à mão. No
simulador, ligar isso levou o d' de 2.10 para 2.66 sem mudar mais nada.

Precisa de ≥4 pessoas com ≥2 amostras para estimar; abaixo disso os pesos ficam neutros (1).

## 4. Template

`buildTemplate()` guarda, por dimensão: **mediana** (centróide), **dispersão pessoal**
(MAD escalado) e **suporte** (quantas amostras sustentam aquela dimensão).

Mediana e MAD em vez de média e desvio-padrão porque com 5 amostras uma única captura ruim
puxaria a média para fora e o cadastro nasceria envenenado.

## 5. Matching

```
sigma_efetivo² = α · sigma_pessoal² + (1−α) · sigma_global²      α = suporte / (suporte + 3)
z              = clamp((x − centróide) / sigma_efetivo, ±4)
distância_grupo = sqrt( Σ peso·z² / Σ peso )        (por grupo)
distância       = sqrt( Σ peso_grupo · distância_grupo² / Σ peso_grupo )
similaridade    = 1 / (1 + e^((distância − ponto_médio) / inclinação))
```

Duas proteções que existem por motivos concretos:

- **Encolhimento para o sigma global** (`α`): com 5 capturas parecidas, o sigma pessoal sai
  minúsculo e a pessoa passaria a **rejeitar a si mesma** na primeira captura um pouco
  diferente. O sigma pessoal só ganha peso conforme o suporte cresce, e tem piso de 35% do
  sigma global.
- **Clamp em ±4**: uma dimensão absurda (colagem, sensor travado) satura em vez de estourar a
  distância inteira.

A **calibração** (`ponto_médio`, `inclinação`) só define a escala 0..1 dos scores. Os defaults
saíram do simulador; `npm run simulate` reimprime a sugestão a cada execução, e num piloto real
ela deve ser refeita com o corpus coletado.

## 6. Decisão

`server/src/biometrics/decision.ts`. O risco do hCaptcha **desloca o limiar** em vez de virar
um termo somado num score único:

| risco hCaptcha | faixa | ajuste no limiar |
|---|---|---|
| < 0.30 | baixo | −0.05 |
| 0.30 – 0.69 | médio | 0 |
| ≥ 0.70 | alto | +0.15 e, por padrão, o melhor resultado possível é `step_up` |

Regras adicionais:

- token inválido/reusado → `deny` imediato, sem nem olhar a biometria;
- similaridade dentro de `stepUpBand` (0.12) abaixo do limiar → `step_up`, não `deny`;
- qualidade de captura ruim → nunca promove, só rebaixa para `step_up`;
- **1:N usa limiar +0.15** e exige **margem mínima de 0.05** entre 1º e 2º colocado.

O acréscimo do 1:N não é arbitrário: a identificação toma o **máximo de N comparações**, então
a chance de um impostor cruzar o limiar cresce com a galeria (`FAR_1:N ≈ 1 − (1−FAR)^N`). No
simulador, sem esse acréscimo, metade das pessoas fora da galeria era aceita por engano.

A resposta sempre carrega o **porquê**: motivos em código estável, distância por grupo, as 5
features que mais divergiram (com z-score), limiar aplicado e a avaliação completa do hCaptcha.

## 7. Antirreplay

Duas amarras independentes:

1. **Sessão de captura** (`POST /v1/sessions/init`): nonce de uso único com validade de 10
   minutos, criado quando a captura *começa*. Reenviar o mesmo snapshot recebe
   `session_already_used`.
2. **Token do hCaptcha**: guardado como SHA-256 (nunca em claro) e recusado se repetir. Ligado
   por padrão só em modo `live`, porque as chaves públicas de teste devolvem sempre o mesmo
   token e o antirreplay bloquearia o desenvolvimento.

Detalhe deliberado: um token de captcha inválido **não** consome a sessão de captura, para que
uma falha de rede no `/siteverify` não obrigue a pessoa a repetir a captura inteira.

## Estrutura

```
server/src/
  biometrics/  contract.ts features.ts template.ts match.ts decision.ts stats.ts
  hcaptcha/    verify.ts          cliente do /siteverify (test/live/mock)
  db/          store.ts           persistência JSON + auditoria
  simulator/   synth.ts metrics.ts run.ts
  app.ts service.ts config.ts schemas.ts index.ts
mobile/src/
  capture/     recorder.ts useCapture.ts useCaptureFlow.ts CaptureTask.tsx
  captcha/     CaptchaProvider.tsx   widget invisível exposto como promise
  screens/     Home Enroll Verify Identify Debug
  api/         client.ts contract.ts (cópia sincronizada)
```

`mobile/src/api/contract.ts` é **cópia verbatim** de `server/src/biometrics/contract.ts`,
gerada por `npm run sync:contract`. O teste `contract-sync.test.ts` falha se as duas
divergirem — mudar o contrato e esquecer de sincronizar quebra o build, de propósito.
