# Como mostrar a PoC para outras pessoas

Três rotas, da mais rápida à mais estável. O gargalo nunca é o app — é o backend
precisar estar alcançável pelo celular de quem vai testar.

| rota | quem consegue testar | custo | tempo |
|---|---|---|---|
| **1. LAN** | quem está na mesma Wi-Fi que você | zero | 5 min |
| **2. Túnel** | qualquer pessoa, enquanto seu notebook estiver ligado | zero | 15 min |
| **3. Deploy + APK** | qualquer pessoa, a qualquer hora | ~zero (planos free) | ~1 h |

## Antes de qualquer rota: se outras pessoas vão se cadastrar

Isto não é burocracia. No instante em que outra pessoa faz o cadastro, você passa
a guardar **dado biométrico de terceiro** — sensível na LGPD (art. 5º, II).

- [ ] **Cifra ligada**: `TEMPLATE_ENCRYPTION_KEY` definida. Sem ela os templates
      ficam em claro, e o servidor avisa no boot.
- [ ] **API fechada**: `API_KEYS` definida. Nas rotas 2 e 3 a API está na
      internet; aberta, qualquer um cadastra e **lista as pessoas**.
- [ ] **Diga o que é coletado** antes da primeira captura: o *ritmo* de digitação
      e de toque, não o texto. Uma frase resolve, e é verdade — dá para mostrar
      no código (`mobile/src/capture/recorder.ts`).
- [ ] **Combine o descarte**: `POST /v1/admin/reset` apaga tudo, ou
      `DELETE /v1/users/:id` apaga uma pessoa. Faça depois da demo e avise que fez.
- [ ] **Use identificadores não-identificáveis** (`pessoa-1`, `pessoa-2`) em vez de
      nome ou e-mail. Um vazamento não vem com o nome ao lado.

Faça isso e a demo é defensável. Não faça, e você tem uma base de biometria de
colegas, em claro, numa API aberta na internet.

## Rota 1 — LAN (mesma Wi-Fi)

```bash
npm run dev     # anote o IP que ele imprime
npm run app     # QR code para o Expo Go
```

Cada pessoa lê o QR com o Expo Go. Se a URL da API estiver errada, dá para
corrigir na tela inicial do app.

Falha quando: a rede isola clientes (comum em Wi-Fi corporativo/guest) ou o
iPhone recusa HTTP puro. Nos dois casos, vá para a rota 2 — o túnel dá HTTPS.

## Rota 2 — Túnel (funciona de qualquer rede)

Dois túneis: um para a API, outro para o bundler do Expo.

```bash
# terminal 1 — backend fechado e cifrado
cd server
API_KEYS=$(openssl rand -hex 24) \
TEMPLATE_ENCRYPTION_KEY=$(openssl rand -base64 32) \
ENROLL_SAMPLES_REQUIRED=3 \
npm run dev
# guarde a API_KEY que você gerou

# terminal 2 — expõe a API com HTTPS (sem conta, URL aleatória)
cloudflared tunnel --url http://localhost:8787
# copie a URL https://....trycloudflare.com

# terminal 3 — o app já embutindo a URL e a chave
cd mobile
EXPO_PUBLIC_API_URL=https://SUA-URL.trycloudflare.com \
EXPO_PUBLIC_API_KEY=a-chave-que-voce-gerou \
npx expo start --tunnel
```

Quem tem Expo Go lê o QR e usa, de qualquer rede. Enquanto seus três terminais
estiverem abertos.

Cuidados: a URL do `trycloudflare` muda a cada execução (recomeçar o túnel
invalida o QR já distribuído), e o `--tunnel` do Expo Go às vezes é lento no
primeiro carregamento — pode levar um minuto.

## Rota 3 — Deploy + APK (a que funciona sem você)

### Backend

Há um `render.yaml` na raiz (blueprint com Postgres gerenciado) e um
`server/Dockerfile`. Render → New → Blueprint → aponte para o repositório, e
preencha os segredos marcados `sync: false`: `API_KEYS`,
`TEMPLATE_ENCRYPTION_KEY` e, se tiver, o par do hCaptcha.

Fly.io, Railway ou um container no seu cloud servem igual — o ativo é o
Dockerfile. Duas coisas que o deploy resolve e o túnel não: HTTPS estável (que o
iOS exige) e funcionar com seu notebook desligado.

Guarde `TEMPLATE_ENCRYPTION_KEY` também **fora** do provedor. Perder a chave é
perder todos os cadastros — não há recuperação, é isso que cifra bem-feita
significa.

### App: Android

```bash
cd mobile
npx eas login                    # conta Expo grátis
# edite eas.json: EXPO_PUBLIC_API_URL e EXPO_PUBLIC_API_KEY no perfil demo-android
npx eas build --profile demo-android --platform android
```

Sai um APK com link de download. Qualquer pessoa instala (precisa permitir
"fontes desconhecidas"), sem loja e sem Expo Go. É a rota de menor atrito para
mostrar a várias pessoas.

### App: iPhone

Aqui o custo aparece: exige **conta Apple Developer paga** (US$ 99/ano) e
distribuição por TestFlight, ou provisionamento ad-hoc com o UDID de cada
aparelho. Para uma primeira demo, Expo Go (rotas 1 e 2) evita isso por completo.

O perfil `demo-ios` já está no `eas.json` para quando a conta existir.

## O que a demo mostra — e o que ela não mostra

**Mostra:** cadastro real, 1:1, rejeição de impostor, 1:N com ranking e margem,
qualidade de captura, trilha de auditoria, e a fusão risco × biometria (na tela
Debug, em modo mock, a *mesma* captura vira `step_up` com risco 0.90).

**Não mostra:** risco de verdade do hCaptcha. Com as chaves públicas de teste o
risco é *derivado* do sucesso do token, e o app marca isso na tela. Para medir
comportamento é preciso sitekey Enterprise com Passive + Invisible.

**Não responde:** se funciona. Duas pessoas testando não produzem FAR/FRR — para
isso são ~30 pessoas × ~10 capturas, e depois recalibrar (`npm run simulate`
imprime a sugestão a cada execução).

## Roteiro de 5 minutos, se for apresentar

1. Abra a tela inicial e mostre `storage`, `autenticação` e `cifra em repouso` —
   estabelece que não é brinquedo.
2. **Cadastre-se** (3 capturas). Comente que o texto não sai do aparelho, só o ritmo.
3. **1:1 com você**: `allow`, e abra o detalhe — distância por grupo e as features
   que mais divergiram. É o que diferencia isto de uma caixa-preta.
4. **1:1 com um voluntário usando o seu identificador**: `deny`. Este é o momento
   da demo.
5. **1:N**: você em 1º, com a margem sobre o 2º.
6. **Tela Debug, risco 0.90**: a mesma captura vira `step_up`. Explique que o
   hCaptcha responde "é humano agora?" e o template responde "é a mesma pessoa?".
7. Encerre com a limitação: os números de acurácia ainda são sintéticos.
