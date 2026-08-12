#!/usr/bin/env bash
#
# Exercita scripts/vercel-setup.sh de ponta a ponta contra uma CLI da Vercel
# falsa, sem publicar nada. O que é real aqui: a geração dos segredos, o
# `npm install`, as migrações no Postgres e todo o controle de fluxo do script.
# O que é dublê: os comandos `vercel` e o `curl` do health check.
#
#   DATABASE_URL_TEST=postgres://... bash scripts/vercel-setup.test.sh
#
# Sem DATABASE_URL_TEST o teste é pulado — as migrações precisam de um banco
# de verdade e não vale a pena dublá-las.

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly API_URL='https://fake-api.vercel.app'
readonly APP_URL='https://fake-app.vercel.app'

if [[ -z "${DATABASE_URL_TEST:-}" ]]; then
  echo 'PULADO: defina DATABASE_URL_TEST para rodar (precisa de um Postgres).'
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
readonly WORK
readonly CALLS="$WORK/calls.log"
: > "$CALLS"

fail() { printf '\033[1;31mFALHOU:\033[0m %s\n' "$*" >&2; exit 1; }
ok() { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------
# dublês
# ---------------------------------------------------------------------------
mkdir -p "$WORK/bin"

# `vercel`: registra a chamada e responde o mínimo que o script consome.
# `deploy` decide a URL pelo diretório, que é justamente o que precisamos
# verificar — que a API é publicada de server/ e o site de mobile/.
cat > "$WORK/bin/vercel" <<EOF
#!/usr/bin/env bash
printf '%s | %s' "\$(basename "\$PWD")" "\$*" >> "$CALLS"
case "\$1" in
  whoami) echo demo-user ;;
  link) ;;
  env)
    case "\$2" in
      add) printf ' <<%s' "\$(cat)" >> "$CALLS" ;;
      rm) [[ -f "$WORK/env-\$3" ]] || { echo >> "$CALLS"; exit 1; } ;;
    esac
    touch "$WORK/env-\$3"
    ;;
  deploy)
    [[ "\$(basename "\$PWD")" == server ]] && echo '$API_URL' || echo '$APP_URL'
    ;;
esac
echo >> "$CALLS"
EOF

# `curl`: o health check aponta para uma URL que não existe. Devolvemos a
# resposta que a API real devolveria, para validar a asserção do script.
cat > "$WORK/bin/curl" <<EOF
#!/usr/bin/env bash
echo "curl | \$*" >> "$CALLS"
echo "\${FAKE_HEALTH:-{\\"ok\\":true,\\"storage\\":\\"postgres\\"}}"
EOF

chmod +x "$WORK/bin/vercel" "$WORK/bin/curl"

run_setup() {
  env PATH="$WORK/bin:$PATH" VERCEL_CMD=vercel \
    DATABASE_URL="$DATABASE_URL_TEST" "$@" \
    bash "$ROOT/scripts/vercel-setup.sh"
}

# valor passado para `vercel env add NOME` (o script manda por stdin)
env_value() {
  grep -oP "env add $1 production <<\K.*" "$CALLS" | tail -n 1
}

# ---------------------------------------------------------------------------
# 1ª execução: do zero
# ---------------------------------------------------------------------------
echo '== primeira execução =='
SECRETS="$ROOT/.vercel-demo-secrets"
BACKUP=''
if [[ -f "$SECRETS" ]]; then
  BACKUP="$WORK/secrets.bak"
  mv "$SECRETS" "$BACKUP"
fi
restore() {
  rm -f "$SECRETS"
  [[ -n "$BACKUP" ]] && mv "$BACKUP" "$SECRETS"
  rm -rf "$WORK"
}
trap restore EXIT

run_setup > "$WORK/out1.log" 2>&1 || { cat "$WORK/out1.log"; fail 'primeira execução retornou erro'; }

[[ -f "$SECRETS" ]] || fail 'não criou o arquivo de segredos'
[[ "$(stat -c '%a' "$SECRETS")" == 600 ]] || fail "arquivo de segredos com modo $(stat -c '%a' "$SECRETS"), esperava 600"
ok 'segredos criados com modo 600'

# shellcheck disable=SC1090
source "$SECRETS"
[[ ${#API_KEY} -ge 32 ]] || fail "API_KEY curta demais (${#API_KEY})"
# 32 bytes em base64 = 44 caracteres
[[ ${#ENCRYPTION_KEY} -eq 44 ]] || fail "ENCRYPTION_KEY com ${#ENCRYPTION_KEY} caracteres, esperava 44"
ok 'chaves com o tamanho certo'

for var in DATABASE_URL API_KEYS TEMPLATE_ENCRYPTION_KEY HCAPTCHA_MODE ENROLL_SAMPLES_REQUIRED SKIP_BOOT_MIGRATIONS; do
  grep -q "server | env add $var production" "$CALLS" || fail "não definiu $var na API"
done
ok 'as seis variáveis da API foram definidas'

[[ "$(env_value API_KEYS)" == "$API_KEY" ]] || fail 'API_KEYS não bate com o arquivo de segredos'
[[ "$(env_value TEMPLATE_ENCRYPTION_KEY)" == "$ENCRYPTION_KEY" ]] || fail 'TEMPLATE_ENCRYPTION_KEY não bate'
[[ "$(env_value SKIP_BOOT_MIGRATIONS)" == 1 ]] || fail 'SKIP_BOOT_MIGRATIONS deveria ser 1 em serverless'
[[ "$(env_value HCAPTCHA_MODE)" == test ]] || fail 'HCAPTCHA_MODE deveria ser test'
ok 'valores das variáveis conferem'

# o elo que mais quebra: a URL que o site embute tem de ser a do deploy da API
[[ "$(env_value EXPO_PUBLIC_API_URL)" == "$API_URL" ]] || fail "site aponta para $(env_value EXPO_PUBLIC_API_URL), esperava $API_URL"
[[ "$(env_value EXPO_PUBLIC_API_KEY)" == "$API_KEY" ]] || fail 'site usa uma chave diferente da API'
ok 'site aponta para a URL da API com a mesma chave'

grep -q "mobile | env add EXPO_PUBLIC_API_URL" "$CALLS" || fail 'variáveis do site foram para o projeto errado'
grep -q "mobile | deploy" "$CALLS" || fail 'não publicou o site'
ok 'cada projeto publicado do seu diretório'

grep -q "$APP_URL" "$WORK/out1.log" || fail 'não imprimiu o link para compartilhar'
ok 'imprimiu o link final'

# ---------------------------------------------------------------------------
# 2ª execução: idempotência
# ---------------------------------------------------------------------------
# Aqui os `env rm` passam a encontrar as variáveis (o dublê criou os marcadores),
# que é o caminho onde um `rm` sem `|| true` derrubaria o script.
echo '== segunda execução (idempotência) =='
: > "$CALLS"
run_setup > "$WORK/out2.log" 2>&1 || { cat "$WORK/out2.log"; fail 'segunda execução retornou erro'; }

PREVIOUS_KEY="$API_KEY"
# shellcheck disable=SC1090
source "$SECRETS"
[[ "$API_KEY" == "$PREVIOUS_KEY" ]] || fail 'regerou os segredos e invalidaria os cadastros existentes'
ok 'reaproveitou os segredos'
grep -q 'reaproveitando' "$WORK/out2.log" || fail 'não avisou que reaproveitou os segredos'
[[ "$(env_value API_KEYS)" == "$API_KEY" ]] || fail 'segunda execução não redefiniu API_KEYS'
ok 'variáveis substituídas, não duplicadas'

# ---------------------------------------------------------------------------
# 3ª execução: API sem Postgres tem de abortar
# ---------------------------------------------------------------------------
# Cenário real: esqueceram de ligar o banco. O boot devolve boot_error e o
# script não pode seguir publicando um site que aponta para uma API morta.
echo '== API sem Postgres =='
: > "$CALLS"
if FAKE_HEALTH='{"error":"boot_error","message":"ambiente serverless detectado sem DATABASE_URL"}' \
    run_setup > "$WORK/out3.log" 2>&1; then
  fail 'seguiu adiante com uma API que subiu sem Postgres'
fi
grep -q 'sem Postgres' "$WORK/out3.log" || fail "abortou, mas sem explicar por quê: $(tail -n 2 "$WORK/out3.log")"
grep -q 'mobile | deploy' "$CALLS" && fail 'publicou o site apesar da API estar quebrada'
ok 'abortou antes de publicar o site'

printf '\n\033[1;32mtodos os cenários passaram\033[0m\n'
