#!/usr/bin/env bash
#
# Publica a PoC na Vercel: a API (server/) e o site (mobile/), dois projetos no
# mesmo repositório. Roda na SUA máquina, porque o `vercel login` abre o
# navegador e a CLI precisa das suas credenciais.
#
#   bash scripts/vercel-setup.sh
#
# O que ele faz, em ordem:
#   1. confere pré-requisitos e faz login na Vercel
#   2. gera os segredos (chave de API e chave de cifra) se ainda não existirem
#   3. aplica as migrações no Postgres que você indicar
#   4. cria/atualiza o projeto da API, define as variáveis e publica
#   5. cria/atualiza o projeto do site apontando para a URL da API e publica
#   6. verifica /healthz e imprime o link para compartilhar
#
# Rodar de novo é seguro: as variáveis são substituídas, não duplicadas.
#
# O que ele NÃO faz: criar o banco. A CLI da Vercel não expõe a criação de
# storage — isso é painel. Tenha uma connection string de Postgres em mão
# (Vercel → Storage → Postgres/Neon, ou neon.tech direto) e informe em
# DATABASE_URL, ou o script pergunta.

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SECRETS_FILE="$ROOT/.vercel-demo-secrets"
readonly API_PROJECT="${API_PROJECT:-hcaptcha-poc-api}"
readonly APP_PROJECT="${APP_PROJECT:-hcaptcha-poc-app}"
# Injetável para que o script possa ser exercitado contra uma CLI falsa
# (scripts/vercel-setup.test.sh) sem publicar nada de verdade.
readonly VERCEL="${VERCEL_CMD:-npx --yes vercel@latest}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() { printf '\n\033[1;31mfalhou:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. pré-requisitos e login
# ---------------------------------------------------------------------------
step 'Conferindo pré-requisitos'
command -v node >/dev/null || die 'node não encontrado (precisa da versão 20 ou maior).'
command -v openssl >/dev/null || die 'openssl não encontrado — é o que gera os segredos.'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || die "node $(node -v) é antigo demais; use 20 ou maior."
info "node $(node -v)"

step 'Login na Vercel'
if $VERCEL whoami >/dev/null 2>&1; then
  info "já autenticado como $($VERCEL whoami 2>/dev/null)"
else
  info 'abrindo o navegador para autenticar…'
  $VERCEL login
fi

# ---------------------------------------------------------------------------
# 2. segredos
# ---------------------------------------------------------------------------
# Gerados aqui, na sua máquina, e guardados fora do git. Guarde uma cópia da
# chave de cifra em outro lugar também: perdê-la é perder todos os cadastros,
# porque não existe "reset" de dado biométrico.
step 'Segredos'
if [[ -f "$SECRETS_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
  info "reaproveitando $SECRETS_FILE"
else
  API_KEY="$(openssl rand -hex 24)"
  ENCRYPTION_KEY="$(openssl rand -base64 32)"
  umask 077
  cat > "$SECRETS_FILE" <<EOF
# Gerado por scripts/vercel-setup.sh — NÃO comite este arquivo.
# ENCRYPTION_KEY cifra os templates biométricos: sem ela os cadastros são
# irrecuperáveis. Guarde uma cópia num gerenciador de senhas.
API_KEY=$API_KEY
ENCRYPTION_KEY=$ENCRYPTION_KEY
EOF
  info "criado $SECRETS_FILE (modo 600)"
fi
[[ -n "${API_KEY:-}" && -n "${ENCRYPTION_KEY:-}" ]] || die "$SECRETS_FILE está incompleto; apague-o e rode de novo."

# ---------------------------------------------------------------------------
# 3. banco e migrações
# ---------------------------------------------------------------------------
step 'Postgres'
if [[ -z "${DATABASE_URL:-}" ]]; then
  info 'Cole a connection string do Postgres (Vercel → Storage, ou neon.tech).'
  read -r -p '    DATABASE_URL: ' DATABASE_URL
fi
[[ "$DATABASE_URL" == postgres* ]] || die 'DATABASE_URL precisa começar com postgres:// ou postgresql://'

info 'instalando dependências do backend…'
(cd "$ROOT/server" && npm install --silent)

info 'aplicando migrações…'
(cd "$ROOT/server" && DATABASE_URL="$DATABASE_URL" npm run --silent db:migrate)

# ---------------------------------------------------------------------------
# helpers de projeto
# ---------------------------------------------------------------------------
# `vercel link --yes` cria o projeto se ele não existir e grava .vercel/ no
# diretório — é isso que faz a Vercel tratar server/ (e mobile/) como raiz.
link_project() {
  local dir="$1" name="$2"
  (cd "$dir" && $VERCEL link --yes --project "$name" >/dev/null)
}

# Substitui em vez de acrescentar: `vercel env add` recusa uma variável que já
# existe, e um `rm` sem `|| true` derrubaria a segunda execução do script.
set_env() {
  local dir="$1" name="$2" value="$3"
  (
    cd "$dir"
    $VERCEL env rm "$name" production --yes >/dev/null 2>&1 || true
    printf '%s' "$value" | $VERCEL env add "$name" production >/dev/null
  )
  info "$name definida"
}

# A CLI imprime a URL do deploy na última linha do stdout.
deploy() {
  local dir="$1"
  (cd "$dir" && $VERCEL deploy --prod --yes 2>/dev/null | tail -n 1)
}

# ---------------------------------------------------------------------------
# 4. projeto da API
# ---------------------------------------------------------------------------
step "API — projeto $API_PROJECT"
link_project "$ROOT/server" "$API_PROJECT"
set_env "$ROOT/server" DATABASE_URL "$DATABASE_URL"
set_env "$ROOT/server" API_KEYS "$API_KEY"
set_env "$ROOT/server" TEMPLATE_ENCRYPTION_KEY "$ENCRYPTION_KEY"
set_env "$ROOT/server" HCAPTCHA_MODE test
set_env "$ROOT/server" ENROLL_SAMPLES_REQUIRED 3
# As migrações já rodaram acima. Em serverless, migrar no boot seria disputado
# por vários cold starts ao mesmo tempo.
set_env "$ROOT/server" SKIP_BOOT_MIGRATIONS 1

info 'publicando…'
API_URL="$(deploy "$ROOT/server")"
[[ "$API_URL" == https://* ]] || die "não consegui ler a URL do deploy da API (recebi: $API_URL)"
info "API em $API_URL"

step 'Conferindo a API'
HEALTH="$(curl -fsS "$API_URL/healthz" || true)"
[[ -n "$HEALTH" ]] || die "GET $API_URL/healthz não respondeu. Veja o log: $VERCEL logs $API_URL"
echo "$HEALTH" | grep -q '"storage":"postgres"' \
  || die "a API subiu sem Postgres. Resposta: $HEALTH"
info "$HEALTH"

# ---------------------------------------------------------------------------
# 5. projeto do site
# ---------------------------------------------------------------------------
# EXPO_PUBLIC_* é embutido no bundle em tempo de build — precisa existir ANTES
# do deploy. Consequência: a chave de API fica visível para quem abrir o app.
# Aceitável numa demo; rotacione depois (API_KEYS aceita várias, por vírgula).
step "Site — projeto $APP_PROJECT"
link_project "$ROOT/mobile" "$APP_PROJECT"
set_env "$ROOT/mobile" EXPO_PUBLIC_API_URL "$API_URL"
set_env "$ROOT/mobile" EXPO_PUBLIC_API_KEY "$API_KEY"

info 'publicando (o build do Expo leva alguns minutos)…'
APP_URL="$(deploy "$ROOT/mobile")"
[[ "$APP_URL" == https://* ]] || die "não consegui ler a URL do deploy do site (recebi: $APP_URL)"

# ---------------------------------------------------------------------------
# 6. pronto
# ---------------------------------------------------------------------------
cat <<EOF

$(printf '\033[1;32m✓ publicado\033[0m')

  link para compartilhar ..... $APP_URL
  API ........................ $API_URL
  segredos ................... $SECRETS_FILE (fora do git)

Antes de deixar outras pessoas cadastrarem:
  • diga a elas que só o ritmo é capturado, nunca o texto digitado;
  • use identificadores não identificáveis ("pessoa-1"), não nome real;
  • apague tudo no fim: curl -X POST $API_URL/v1/admin/reset \\
      -H "Authorization: Bearer \$API_KEY"
  • rotacione a chave depois da demo: ela está visível no bundle do site.

Para que cada push publique sozinho, conecte os dois projetos ao repositório
no painel (Settings → Git). Este script publica por CLI, sem essa ligação.
EOF
