# API

Base: `http://localhost:8787`.
Os exemplos usam `HCAPTCHA_MODE=mock` (token `mock:<risco>`); em `test`/`live` o token vem do
SDK no app.

Erros seguem sempre `{ "error": "codigo_estavel", "message": "…", "details": … }`.

## Autenticação

Sem `API_KEYS` configurado a API fica **aberta** (o servidor avisa no boot). Com chaves
configuradas, tudo menos `/healthz` exige:

```bash
curl -H "Authorization: Bearer $API_KEY" localhost:8787/v1/users
curl -H "x-api-key: $API_KEY"           localhost:8787/v1/users   # equivalente
```

Sem chave ou com chave errada: **401 `unauthorized`**. Várias chaves separadas por vírgula
permitem rotação sem downtime. `/healthz` fica aberto de propósito, para o cliente descobrir
que precisa de chave — ele informa *se* há autenticação, nunca *qual* é a chave.

## `GET /healthz`

```bash
curl -s localhost:8787/healthz
```

```json
{
  "ok": true, "featureVersion": 1, "captchaMode": "mock", "users": 3, "uptimeSec": 41,
  "authRequired": true, "encryptionAtRest": true
}
```

Única rota que nunca exige chave. `authRequired` e `encryptionAtRest` existem para o cliente
mostrar o estado real da instalação — o app usa isso para avisar quando os templates estão sendo
gravados em claro.

## `GET /v1/config`

Configuração pública: sitekey, modo do captcha, política de decisão, parâmetros de calibração e
o catálogo completo das 45 features. O app consome isto para não hardcodar nada. O `secret`
nunca aparece aqui (há teste garantindo).

## `POST /v1/sessions/init`

Abre a sessão de captura. Chame quando a captura **começa**.

```bash
curl -sX POST localhost:8787/v1/sessions/init
```

```json
{
  "sessionId": "3f2b…",
  "sitekey": "10000000-ffff-ffff-ffff-000000000001",
  "rqdata": null,
  "expiresAt": "2026-08-11T15:10:00.000Z",
  "captchaMode": "mock"
}
```

Uso único, validade de 10 min (`SESSION_TTL_MS`). Reenviar o mesmo `sessionId` devolve
`session_already_used`.

## `POST /v1/enroll`

```json
{
  "userId": "rodrigo.tazima",
  "displayName": "Rodrigo Tazima",
  "captchaToken": "mock:0.1",
  "sample": { "sessionId": "3f2b…", "task": "cadastro-1", "device": {"os":"ios"},
              "keystrokes": [{"t":420,"cls":"char"}],
              "taps": [{"t":900,"dt":110,"x":0.3,"y":0.5}],
              "gestures": [{"points":[{"t":1000,"x":0.2,"y":0.4}]}],
              "motion": [{"t":0,"ax":0,"ay":0.1,"az":0.99,"gx":0,"gy":0,"gz":0}],
              "timings": {"durationMs":12000,"firstInteractionMs":420} }
}
```

Resposta:

```json
{
  "userId": "rodrigo.tazima", "displayName": "Rodrigo Tazima",
  "samplesAccepted": 3, "samplesRequired": 5, "enrolled": false,
  "quality": { "ok": true, "score": 1, "issues": [], "counts": {…}, "availableGroups": [...] },
  "captcha": { "success": true, "risk": 0.1, "riskBand": "low", "derived": false, … }
}
```

- Amostra de qualidade baixa volta **200** com `rejected: {reason, details}` e **não** é
  gravada — é situação normal de recaptura, não erro de cliente.
- `enrolled: true` quando `samplesAccepted >= samplesRequired`; aí o template é (re)construído.
- **403 `captcha_high_risk`** quando o risco é alto: não se cadastra o comportamento de quem o
  hCaptcha já classifica como ameaça.
- **403 `captcha_rejected`** para token inválido ou reusado.

## `POST /v1/verify` — 1:1

```bash
curl -sX POST localhost:8787/v1/verify -H 'content-type: application/json' \
  -d '{"userId":"rodrigo.tazima","captchaToken":"mock:0.05","sample":{…}}'
```

```json
{
  "userId": "rodrigo.tazima",
  "decision": "allow",
  "reasons": ["biometric_match", "hcaptcha_low_risk"],
  "match": {
    "distance": 0.81, "similarity": 0.874,
    "perGroup": { "keystroke": 0.72, "gesture": 0.91, "tap": 0.64, "motion": 0.88, "session": 1.02 },
    "topContributors": [{ "feature": "g_vmax_mean", "z": 1.83 }],
    "dimensionsCompared": 45
  },
  "threshold": 0.55,
  "quality": {…}, "captcha": {…}, "latencyMs": 7
}
```

`decision` ∈ `allow` | `step_up` | `deny`. Sempre acompanhada de `reasons` com códigos estáveis
(o app traduz em `mobile/src/strings.ts`).

| situação | HTTP | resultado |
|---|---|---|
| usuário inexistente | 404 | `user_not_found` |
| cadastro incompleto | 200 | `deny` + `not_enrolled` |
| token inválido | 200 | `deny` + `captcha_invalid` (e a sessão **não** é consumida) |
| sessão inválida/expirada/reusada | 400 | `session_unknown` / `session_expired` / `session_already_used` |

## `POST /v1/identify` — 1:N

```bash
curl -sX POST localhost:8787/v1/identify -H 'content-type: application/json' \
  -d '{"captchaToken":"mock:0.05","topK":5,"sample":{…}}'
```

```json
{
  "decision": "allow",
  "reasons": ["biometric_match", "hcaptcha_low_risk"],
  "matchedUserId": "rodrigo.tazima",
  "candidates": [
    { "userId": "rodrigo.tazima", "displayName": "Rodrigo Tazima", "rank": 1, "match": {…} },
    { "userId": "juliano.basilio", "displayName": "Juliano Basilio", "rank": 2, "match": {…} }
  ],
  "margin": 0.37, "threshold": 0.70, "requiredMargin": 0.05,
  "quality": {…}, "captcha": {…}, "latencyMs": 11
}
```

- `threshold` do 1:N é **maior** que o do 1:1 (`POLICY_IDENTIFY_BOOST`, +0.15 por padrão).
- 1º e 2º muito próximos (`margin < requiredMargin`) → `step_up` + `ambiguous_candidates`, com
  o candidato preservado para revisão manual.
- Galeria vazia → `deny` + `empty_gallery`.
- `matchedUserId` é `null` sempre que a decisão for `deny`.

## Administração

| rota | efeito |
|---|---|
| `GET /v1/users` | lista com `samples` e `enrolled` |
| `GET /v1/users/:id/template` | centróide, dispersão, suporte, amostras e estatística do corpus (depuração) |
| `DELETE /v1/users/:id` | apaga a pessoa e a remove da galeria (204; 404 se não existir) |
| `GET /v1/audit?limit=50` | últimas decisões: tipo, decisão, similaridade, risco, motivos |
| `POST /v1/admin/reset` | zera a base. Em modo `live` exige o header `x-confirm-reset: yes` |

Todas exigem a chave de API quando `API_KEYS` está configurado.

## Erros de infraestrutura

| código | HTTP | quando |
|---|---|---|
| `unauthorized` | 401 | chave de API ausente ou inválida |
| `encryption_error` | 500 | dado cifrado ilegível em tempo de execução (chave trocada) |

Chave de cifra errada no **boot** não vira erro HTTP: o servidor não sobe, com mensagem
explícita. Subir com a base aparentemente vazia seria pior — o próximo cadastro sobrescreveria
os dados que ainda estão lá, cifrados.

## Limites de payload

`express.json` aceita até 4 MB; o schema zod limita 4000 eventos por tipo, 500 gestos e 2000
pontos por gesto. Uma captura típica de 15 s fica em ~120 KB. Violações voltam **400
`validation_error`** com a lista de campos.
