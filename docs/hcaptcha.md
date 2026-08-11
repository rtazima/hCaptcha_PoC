# hCaptcha nesta PoC

## O que o hCaptcha entrega — e o que não entrega

**Entrega:** um veredito e, em contas Enterprise, um **risco** de 0.0 a 1.0 calculado a partir
de sinais passivos (comportamento no dispositivo, reputação, sinais de automação). Em modo
*invisible* nenhuma caixinha aparece; em modo *passive* nenhum desafio é mostrado jamais.

**Não entrega:** template comportamental, embedding, comparação entre duas sessões, endpoint de
1:1 ou 1:N, nem identificação de pessoa. O risco é por *sessão*, não por *identidade*.

Consequência prática: **cadastro, 1:1 e 1:N não podem ser feitos com o hCaptcha.** Nesta PoC
eles são feitos pelo motor em `server/src/biometrics/`, e o hCaptcha entra como camada de risco
que desloca o limiar. Vale alinhar isso com o time antes da apresentação.

Atenção a um detalhe que inverte a leitura de quem vem do reCAPTCHA: no hCaptcha
**`score` é risco** — 0.0 = sem risco, 1.0 = ameaça confirmada. No reCAPTCHA v3 é o contrário.
Ler ao revés faz o sistema liberar exatamente quem deveria bloquear.

## Invisible × Passive

| configuração | checkbox | desafio | disponibilidade |
|---|---|---|---|
| normal / compact | sim | quando necessário | todos |
| **invisible** | não | quando necessário | todos |
| **passive** | (irrelevante) | **nunca** | apenas Enterprise |
| **invisible + passive** | não | nunca | apenas Enterprise — é o alvo desta PoC |

O modo *passive* exige consumir o risco: sem desafio, a única saída é decidir com base no
`score`. É justamente por isso que ele é Enterprise.

No app, `mobile/src/captcha/CaptchaProvider.tsx` usa `size="invisible"` e expõe a prop
`passiveSiteKey` como um **toggle na tela Debug**. Cuidado: com `passiveSiteKey` ligado o SDK
não monta modal nenhum — se o sitekey precisar mostrar um desafio, a verificação fica pendurada
até o timeout de 90 s. Ligue só com sitekey realmente configurado como Passive.

## Chaves

### Teste (default deste repositório)

```
sitekey  10000000-ffff-ffff-ffff-000000000001
secret   0x0000000000000000000000000000000000000000
```

Par público documentado pelo hCaptcha: nunca desafia, sempre passa e **devolve sempre o mesmo
token**. Serve para validar o encanamento inteiro sem conta nenhuma.

Duas consequências que o código trata explicitamente:

1. A resposta **não tem `score`**. O backend então *deriva* o risco do sucesso/falha
   (`HCAPTCHA_DERIVED_RISK_PASS=0.15`) e marca `derived: true` — o app mostra esse aviso na
   tela de resultado. Você vê a fusão funcionando, mas não está medindo comportamento.
2. Como o token é sempre o mesmo, o **antirreplay fica desligado** fora do modo `live`
   (`HCAPTCHA_ENFORCE_SINGLE_USE`), senão a segunda requisição já seria recusada.

O hCaptcha também documenta pares de teste Enterprise (o de "usuário seguro" é
`20000000-ffff-ffff-ffff-000000000002`) para exercitar cenários de score. Confirme os pares
vigentes e seus secrets com o suporte do hCaptcha antes de usá-los — são de conta Enterprise e
mudam sem aviso.

### Produção / piloto

1. No dashboard do hCaptcha, crie um sitekey e configure **Invisible** + **Passive**
   (Passive exige plano Enterprise).
2. Coloque no `server/.env`:

```bash
HCAPTCHA_MODE=live
HCAPTCHA_SITEKEY=seu-sitekey
HCAPTCHA_SECRET=seu-secret
```

O app **não** hardcoda o sitekey: ele lê de `GET /v1/config`. Trocar de chave é reiniciar o
backend, não republicar o app.

## `/siteverify`

`server/src/hcaptcha/verify.ts`. `POST https://api.hcaptcha.com/siteverify`,
`application/x-www-form-urlencoded`:

| campo | obrigatório | observação |
|---|---|---|
| `secret` | sim | nunca sai do servidor |
| `response` | sim | token devolvido pelo SDK |
| `remoteip` | não | IP do cliente (a PoC envia) |
| `sitekey` | não | reforça a validação (a PoC envia) |

Resposta:

```json
{
  "success": true,
  "challenge_ts": "2026-08-11T12:00:00.000Z",
  "hostname": "app.exemplo.com",
  "credit": false,
  "error-codes": [],
  "score": 0.12,
  "score_reason": ["passive-signals"]
}
```

`score` e `score_reason` **só existem em contas Enterprise**. Sem eles o backend deriva o risco
e sinaliza a derivação — nada de fingir que mediu o que não mediu.

Comportamento em falha, todo coberto por teste:

| situação | resultado |
|---|---|
| token ausente | `missing-input-response`, sem chamada de rede |
| token inválido | `success: false`, risco 0.9 → `deny` |
| token já usado (modo live) | `token-replay` → `deny` |
| HTTP 5xx do hCaptcha | `siteverify-http-500` → **fail-closed** |
| rede fora / timeout (8 s) | `siteverify-unreachable` → **fail-closed** |
| `score` fora de 0..1 | limitado a 0..1 |

Fail-closed é decisão de política: se não é possível avaliar risco, o pedido não passa. Num
produto real isso precisa de circuit breaker, senão uma indisponibilidade do hCaptcha derruba
o login inteiro.

## SDK React Native

`@hcaptcha/react-native-hcaptcha@4.1.0` (depende de `react-native-webview`).

Protocolo real do `onMessage`, lido do fonte do pacote:

```
event.success === true  && data.length > 35   -> é o token
data === 'open'                               -> desafio abriu (siga esperando)
event.success === false                       -> erro: 'challenge-closed', 'expired',
                                                 'error', 'script-error', 'cancel', ...
```

O provider embrulha isso numa promise (`getToken()`) e trata três armadilhas:

- **`markUsed()`**: o SDK arma um timer de 120 s que dispara `expired`. A PoC chama `markUsed()`
  **depois** da resposta do backend, que é quando o token deixou de importar.
- **eventos atrasados**: depois de resolver, a tentativa é encerrada e eventos posteriores são
  ignorados — sem isso um `expired` tardio rejeitaria uma promise já resolvida.
- **`hide()` sem argumento não emite evento** (só `hide('backdrop')` emite `cancel`), então
  fechar após o sucesso é seguro.

### `prop-types`

A versão 4.1.0 importa `prop-types` sem declarar a dependência. O Metro falha ao empacotar com
`Unable to resolve module prop-types`. Por isso `prop-types` está explícito no
`mobile/package.json` — descoberto rodando `npx expo export`, não em teoria.

### Journey tracking (Enterprise)

`initJourneyTracking({ navigationContainerRef, touchCapture: true })` em `App.tsx`, mais
`userJourney` no widget. Registra transições de tela e gestos básicos e envia junto com a
verificação. A documentação do SDK afirma que **não** captura conteúdo de texto, buscas nem
tamanho de texto. Em conta não-Enterprise o sinal é simplesmente ignorado do outro lado.

### `rqdata`

Payload assinado (Enterprise) que amarra o token a uma sessão/usuário. O backend expõe via
`HCAPTCHA_RQDATA` em `GET /v1/config` e o app repassa em `verifyParams.rqdata`. Nesta PoC é um
valor estático de configuração; em produção ele deve ser gerado **por sessão** no servidor —
`rqdata` fixo não protege contra reuso de token entre sessões.

## Modo mock (só desenvolvimento)

Com `HCAPTCHA_MODE=mock` o widget não carrega e o token carrega o risco:

| token | efeito |
|---|---|
| `mock:0.85` | sucesso com risco 0.85 (faixa alta) |
| `mock:fail` | `success: false` |
| qualquer outro | sucesso com `HCAPTCHA_MOCK_RISK` |

É o que o simulador e os testes usam, e o que permite demonstrar em segundos que a **mesma
captura** vira `allow` com risco 0.05 e `step_up` com risco 0.90. Nunca em produção: aceitar
token arbitrário é exatamente o buraco que o captcha deveria fechar.

## Fontes

- [Invisible Captcha — docs.hcaptcha.com/invisible](https://docs.hcaptcha.com/invisible/)
- [Pro Features — docs.hcaptcha.com/pro](https://docs.hcaptcha.com/pro/)
- [Enterprise Overview — docs.hcaptcha.com/ent_overview](https://docs.hcaptcha.com/ent_overview/)
- [Developer Guide — docs.hcaptcha.com](https://docs.hcaptcha.com/)
- [hCaptcha/react-native-hcaptcha](https://github.com/hCaptcha/react-native-hcaptcha)
- [Chaves públicas de teste](https://github.com/goto-bus-stop/hcaptcha-test-keys)
