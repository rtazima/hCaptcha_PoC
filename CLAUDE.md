# Contexto do projeto

PoC para avaliar **hCaptcha como biometria comportamental**, com cadastro,
verificação 1:1 e identificação 1:N. App Expo + backend Node.

## A correção que sustenta o desenho (leia antes de mexer)

A premissa original da conversa era "o hCaptcha é biometria comportamental, faz
cadastro e match". **Não é.** O hCaptcha devolve um `score` de **risco**
(0.0 = sem risco, 1.0 = ameaça — inverso do reCAPTCHA v3), e só com sitekey
Enterprise. Ele não expõe template comportamental nem tem endpoint de 1:1 ou 1:N.

Então o motor biométrico (45 features, template, matcher) é **deste repositório**,
não do hCaptcha. E o risco do hCaptcha não é somado ao score biométrico: ele
**desloca o limiar** de decisão (step-up adaptativo) em `src/biometrics/decision.ts`.
Somar os dois viraria um número opaco que ninguém consegue auditar.

Isso precisa estar alinhado com o Juliano (quem trouxe a referência) antes de
qualquer apresentação — a expectativa dele pode ainda ser a premissa original.

## Layout

```
server/   API Express + motor biométrico. src/biometrics/ é o núcleo:
          features.ts (catálogo de 45 dims), match.ts, decision.ts (política).
          api/[...path].ts é a entrada serverless (Vercel), fora do build.
mobile/   App Expo. src/capture/ grava o comportamento; arquivos .web.tsx são
          a implementação para navegador (PanResponder não serve na web).
scripts/  vercel-setup.sh + seu teste com CLI dublada.
docs/     arquitetura, hcaptcha, api, privacidade, demo (rotas de deploy).
```

## Comandos

```bash
npm run setup            # instala server + mobile
npm run check            # typecheck + 197 testes
npm run dev              # API em :8787
npm run app              # Expo
npm run simulate         # métricas com dados sintéticos (--users, --seed, --api)
npm run dev:serverless   # roda a função da Vercel localmente (precisa DATABASE_URL)
npm run deploy:vercel    # publica os dois projetos
npm run build:web        # bundle web (o --clear é obrigatório, ver abaixo)
```

## Invariantes que quebram em silêncio se ignoradas

- **Nunca capture o texto digitado.** `KeystrokeEvent` tem só `t` e `cls`
  (`char`/`backspace`/`space`/`enter`). Acrescentar o caractere transformaria a
  PoC num keylogger. É decisão de privacidade, não detalhe.
- **O contrato é duplicado de propósito.** `server/src/biometrics/contract.ts` é
  copiado para `mobile/src/api/contract.ts` por `npm run sync:contract`, e
  `tests/contract-sync.test.ts` falha se divergirem. Editou um, rode o sync.
- **Perder `TEMPLATE_ENCRYPTION_KEY` é perder todos os cadastros.** Dado
  biométrico não se "reseta": vazou o jeito de digitar, vazou para sempre.
- **Em serverless, armazenamento em arquivo é recusado no boot** (`src/db/index.ts`).
  O disco é efêmero: gravaria, responderia 200 e perderia tudo na invocação
  seguinte. Exige Postgres. `POSTGRES_URL` também é aceito (nome que a Neon injeta).
- **`EXPO_PUBLIC_*` é embutido no bundle** — a chave de API fica visível para
  quem abrir o app. Aceitável em demo; rotacione depois. E o Metro reaproveita
  bundle: sem `--clear`, mudar a variável não surte efeito.
- **Modos do hCaptcha:** `test` usa as chaves públicas (nunca desafiam, não
  devolvem score, sempre o mesmo token — por isso o antirreplay fica desligado
  fora de `live`); `mock` codifica o risco no token (`mock:0.85`, `mock:fail`) e
  é o que os testes e o simulador usam; `live` exige sitekey Enterprise.

## O que está verificado e o que não está

Verificado: 197 testes; Postgres ponta a ponta (vetores cifrados, exclusão LGPD);
o build web em Chromium real via Playwright; o caminho serverless local com
Postgres.

**Não** verificado: nunca rodou em aparelho físico; a chamada real ao
`api.hcaptcha.com/siteverify` nunca aconteceu (bloqueada no ambiente onde foi
escrito); o deploy na Vercel não foi executado. E a acurácia é **sintética** —
d′ ~2.5–5.2, EER 3–13% saem do simulador, não de gente. Para número real:
~30 pessoas × ~10 capturas, e recalibrar `MATCH_MIDPOINT`/`MATCH_STEEPNESS` com
a sugestão que o simulador imprime. Não apresente esses números como acurácia de
produto.
