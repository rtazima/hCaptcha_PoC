# PoC — hCaptcha invisível + biometria comportamental

Prova de conceito ponta a ponta: **app mobile** (React Native/Expo) que coleta sinais
comportamentais e um **backend** que faz **cadastro (enrollment)**, **verificação 1:1** e
**identificação 1:N**, usando o **risco do hCaptcha invisível** dentro da decisão.

```
┌───────────────────── app Expo ─────────────────────┐      ┌────────── backend Node/TS ──────────┐
│ digitação (só o ritmo)   ┐                         │      │ extração de 45 features             │
│ arraste (cinemática)     ├─ eventos crus ──────────┼─────▶│ template (mediana + dispersão)      │
│ toques (tempo de pressão)│                         │      │ matching 1:1 e 1:N                  │
│ acelerômetro/giroscópio  ┘                         │      │ motor de decisão                    │
│                                                    │      │        ▲                            │
│ @hcaptcha/react-native-hcaptcha ── token ──────────┼─────▶│ POST api.hcaptcha.com/siteverify    │
└────────────────────────────────────────────────────┘      └─────────────────────────────────────┘
                                                                     │
                                              allow · step_up · deny ┘ (com o porquê)
```

## O ponto mais importante antes de qualquer demo

**O hCaptcha não faz match de identidade.** Ele responde *"é um humano legítimo agindo
agora?"* e devolve um **risco de 0.0 (sem risco) a 1.0 (ameaça confirmada)** — note que é o
inverso do reCAPTCHA v3. Ele não expõe template comportamental, não compara duas sessões e
não tem endpoint de 1:1 ou 1:N.

Então esta PoC tem **dois motores independentes**:

| | pergunta que responde | quem faz |
|---|---|---|
| **hCaptcha invisível** | é humano/legítimo *agora*? | serviço do hCaptcha (risco passivo) |
| **Biometria comportamental** | é a *mesma pessoa* de antes? | motor deste repositório |

O cadastro, o 1:1 e o 1:N que o Juliano pediu são o **segundo** motor. O hCaptcha entra como
camada de risco que **desloca o limiar** biométrico (step-up adaptativo) — não como um número
somado num score opaco. Se a expectativa era que o hCaptcha entregasse o template biométrico,
essa expectativa não se sustenta e é melhor alinhar isso antes da apresentação.

O motor biométrico foi escrito com interface trocável: `extractFeatures` → `buildTemplate` →
`matchScore`/`identify`. Para plugar o engine de face da FaceSign no lugar (ou ao lado), o
ponto de troca é `server/src/biometrics/` — o resto da API não muda.

## Como rodar

Requisitos: Node 20.11+ e o app **Expo Go** no celular (nada precisa de build nativo).

```bash
# 1. dependências
npm run setup

# 2. backend (sobe em 0.0.0.0:8787 e imprime o IP da LAN)
npm run dev

# 3. app — em outro terminal
cd mobile
EXPO_PUBLIC_API_URL=http://SEU_IP_LAN:8787 npm start
# leia o QR code com o Expo Go
```

A URL da API também pode ser trocada **dentro do app**, na tela inicial — em demo o IP muda
toda hora.

Sem `.env`, o backend sobe com as **chaves públicas de teste do hCaptcha**
(`10000000-ffff-ffff-ffff-000000000001`). Elas validam todo o encanamento, mas **nunca
desafiam e não devolvem `score`**: o risco exibido no app aparecerá marcado como *derivado*.
Para exercitar biometria comportamental de verdade, veja [docs/hcaptcha.md](docs/hcaptcha.md).

## Os três fluxos no app

1. **Cadastro** — 5 capturas da mesma tarefa (digitar uma frase fixa, arrastar, tocar nos
   alvos). O template só fecha ao atingir o mínimo; capturas ruins são recusadas com o motivo.
2. **Verificação 1:1** — escolhe-se de quem é o template e a captura de agora é comparada
   contra ele. Para ver rejeição de impostor, peça a outra pessoa para fazer a captura
   escolhendo o *seu* identificador.
3. **Identificação 1:N** — sem dizer quem é: a captura é comparada com a galeria inteira e o
   app mostra o ranking, a margem entre 1º e 2º e a decisão.

A tela **Debug** mostra a política vigente, o catálogo de features, a trilha de auditoria e —
em modo mock — permite injetar risco 0.05 / 0.50 / 0.90 para ver a **mesma captura** mudar de
`allow` para `step_up` só porque o risco subiu.

## Verificando sem celular

O simulador sobe a API em memória, gera pessoas sintéticas (cada uma com perfil latente de
ritmo, cinemática e tremor) e mede o que se mede em biometria:

```bash
npm run simulate                       # 15 pessoas, 5 capturas de cadastro cada
npm run simulate -- --users 30 --seed 7 --json /tmp/metricas.json
```

Resultados em 4 seeds (15 pessoas, 5 amostras de cadastro, 60 tentativas genuínas, 240 de
impostor por execução):

| métrica | faixa observada |
|---|---|
| d' (separação genuíno × impostor) | 2.5 – 4.4 |
| EER | 3.3% – 13.5% |
| FAR no limiar operacional (0.55) | 2.9% – 7.5% |
| FRR no mesmo limiar | 1.7% – 15.0% |
| acerto rank-1 no 1:N | 80% – 100% |
| aceitação indevida de quem está fora da galeria | 0% – 25% |
| robô (temporização perfeita) aceito | 0 de 32 tentativas |

**Estes números são de dados sintéticos.** Eles provam que o encanamento fecha e que o motor
separa perfis; **não** são acurácia de produto. A variação entre seeds (a seed 7 é bem pior
que as outras) é justamente o recado: com 15 pessoas e 5 amostras, o intervalo de confiança é
largo. Só coleta real com dezenas de pessoas responde acurácia — veja *Limitações*.

O simulador imprime, a cada execução, a **calibração sugerida** a partir das distâncias
observadas. Recalibre com dados reais: `MATCH_MIDPOINT` e `MATCH_STEEPNESS` definem a *escala*
dos scores, e limiar fora de escala é a forma mais comum de um piloto biométrico parecer
quebrado sem estar.

## Segurança (o que já está no código)

Duas coisas que o doc de privacidade listava como bloqueadores para sair do laboratório já estão
implementadas, ambas **desligadas por padrão** para não quebrar o fluxo de demo — mas com aviso
alto no boot quando estão desligadas:

```bash
# fecha a API (mínimo 16 caracteres; aceita várias, separadas por vírgula, para rotação)
API_KEYS=$(openssl rand -hex 24)

# cifra os campos biométricos em repouso (AES-256-GCM)
TEMPLATE_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

**Autenticação.** Chave em `Authorization: Bearer <chave>` (ou `x-api-key`). Só `/healthz` fica
aberto — de propósito, para o app conseguir dizer "falta a chave" em vez de mostrar um 401 cru.
Comparação em tempo constante sobre hashes; a chave em claro nunca é guardada nem logada. Chave
curta faz o servidor **não subir**, em vez de aceitar em silêncio.

**Cifra em repouso.** Só os campos biométricos (vetores e template) são cifrados; a estrutura em
volta continua legível, então `cat data/db.json` ainda mostra quem existe e a trilha de
auditoria — dá para auditar sem ter a chave. GCM autentica: arquivo adulterado falha em vez de
devolver dado corrompido em silêncio. Chave errada faz o servidor falhar no boot com mensagem
explícita, em vez de subir com a base aparentemente vazia. Base já gravada em claro é lida
normalmente e convertida na primeira escrita, sem script de migração.

O ponto de troca para o esquema de autenticação de vocês (JWT, gateway, mTLS) é
`server/src/auth.ts` — só esse arquivo.

## Qualidade

```bash
npm run check      # typecheck do backend e do app + 149 testes
```

- **149 testes** (vitest) cobrindo extração de features, template, matching, motor de decisão,
  cliente do `/siteverify` (com `fetch` dublado), persistência, cifra em repouso, autenticação e
  a API inteira via supertest.
- O app foi **empacotado com o Metro** (`npx expo export`) para garantir que resolve e compila
  de verdade — foi isso que revelou que o `@hcaptcha/react-native-hcaptcha@4.1.0` importa
  `prop-types` sem declarar a dependência (por isso ela está explícita no `mobile/package.json`).

## Documentação

| documento | conteúdo |
|---|---|
| [docs/arquitetura.md](docs/arquitetura.md) | pipeline completo: features, template, matching, decisão, antirreplay |
| [docs/hcaptcha.md](docs/hcaptcha.md) | invisible × passive, chaves, `/siteverify`, `rqdata`, o que dá e o que não dá |
| [docs/api.md](docs/api.md) | endpoints com exemplos de `curl` |
| [docs/privacidade.md](docs/privacidade.md) | LGPD: dado biométrico é sensível — o que isso exige |

## Limitações (leia antes de apresentar)

1. **Acurácia é desconhecida.** Os números acima são sintéticos. Um piloto honesto precisa de
   ~30 pessoas × ~10 capturas para estimar FAR/FRR com intervalo utilizável.
2. **Não houve execução em aparelho real** neste ambiente: o app passa por typecheck e
   empacotamento, mas a captura de sensores e a exibição do widget do hCaptcha precisam ser
   validadas em Android e iOS de verdade. É o primeiro item da lista de próximos passos.
3. **A chamada real ao `/siteverify` não foi exercitada.** O ambiente onde este código foi
   escrito bloqueia `api.hcaptcha.com`, então o caminho `live`/`test` contra o endpoint de
   verdade está coberto apenas por testes com `fetch` dublado. O que *foi* verificado no ar é o
   comportamento **fail-closed**: sem alcançar o hCaptcha, o cadastro é recusado
   (`siteverify-unreachable` / `siteverify-http-403`) em vez de passar batido.
4. **Digitação em teclado de software é irregular.** O `onKeyPress` não dispara para todas as
   teclas em parte dos teclados Android; há uma rede de segurança baseada em `onChangeText`
   (veja `mobile/src/capture/useCapture.ts`), e colagem é detectada e sinalizada porque
   distorce o ritmo.
5. **Biometria comportamental muda com o contexto** — em pé, deitado, apressado, com a outra
   mão. Isso aparece como aumento de FRR. É por isso que a decisão tem `step_up` em vez de só
   allow/deny, e por isso existe (desligada por padrão) a adaptação incremental do template.
6. **Armazenamento é um arquivo JSON** (`server/data/db.json`), proposital para a PoC ser
   inspecionável. A interface `Store` é o ponto de troca para Postgres.
7. **Autenticação e cifra vêm desligadas por padrão.** Existem e são testadas (veja
   *Segurança*), mas sem `API_KEYS` a API está aberta a quem estiver na mesma rede, e sem
   `TEMPLATE_ENCRYPTION_KEY` os templates ficam em claro. Ligue as duas antes de coletar dado de
   gente de verdade.

## Próximos passos sugeridos

1. Rodar em Android e iOS físicos e conferir sensores, teclado e o widget invisível.
2. Obter um sitekey **Enterprise Passive + Invisible** para consumir `score`/`score_reason` de
   verdade (com as chaves de teste o risco é derivado, não medido).
3. Coleta piloto com ~30 pessoas × ~10 capturas → recalibrar → publicar curva ROC real.
4. Decidir o papel do comportamental no produto: reforço de risco (step-up) tende a valer mais
   que fator de identidade isolado, e é onde o 1:N tem menos risco de falso positivo.
5. Trocar o JSON por Postgres (a interface `Store` é o ponto de troca). Autenticação e cifra em
   repouso já estão feitas — falta gestão de chave num KMS em vez de variável de ambiente.
