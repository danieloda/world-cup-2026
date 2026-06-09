#!/usr/bin/env bash
# ============================================================================
# bootstrap-local.sh — Reconstrói o ambiente de testes LOCAL com PARIDADE DE PROD.
# ============================================================================
# Um comando: reset (52 migrations) → seed base → admin → massa sintética (~70).
# Idempotente e reprodutível. NUNCA toca produção: opera só no stack Docker local
# (supabase_*_world-cup-2026) e nas credenciais do .env.e2e.local.
#
# USO
#   ./scripts/e2e/bootstrap-local.sh                 # reset + seed (estado PRÉ-torneio)
#   ./scripts/e2e/bootstrap-local.sh --playout       # + joga o torneio (estado pontuado)
#   ./scripts/e2e/bootstrap-local.sh --users=100     # outra escala
#   ./scripts/e2e/bootstrap-local.sh --serve         # + sobe o servidor estático na 3000
#   ./scripts/e2e/bootstrap-local.sh --no-enrichment # sem odds/h2h/previsões
#
# PRÉ-REQUISITOS
#   - Docker rodando + stack local de pé (npx supabase start)
#   - .env.e2e.local com SUPABASE_URL=http://127.0.0.1:54321 + SERVICE_ROLE local
#   - npx supabase (CLI baixada on-demand) + Playwright chromium (npx playwright install)
#
# Depois de usar, p/ voltar o front a PRODUÇÃO:  npm run build:config  (lê .env)
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/../.."          # raiz do repo
ROOT="$(pwd)"
CID="supabase_db_world-cup-2026"
PLAYOUT=0 ; SERVE=0 ; USERS=70 ; ENRICH_FLAG="" ; REALISTIC_FLAG=""

for arg in "$@"; do
  case "$arg" in
    --playout) PLAYOUT=1 ;;
    --serve) SERVE=1 ;;
    --users=*) USERS="${arg#*=}" ;;
    --no-enrichment) ENRICH_FLAG="--no-enrichment" ;;
    --realistic) REALISTIC_FLAG="--realistic" ;;   # massa humana (demo), sem perfis-borda
    *) echo "flag desconhecida: $arg" ; exit 2 ;;
  esac
done

c(){ printf "\033[1;34m▶ %s\033[0m\n" "$1"; }
ok(){ printf "\033[32m  ✓ %s\033[0m\n" "$1"; }
die(){ printf "\033[31m  ✗ %s\033[0m\n" "$1"; exit 1; }

# ---- 0. pré-checks + guard-rail ----
c "Pré-checks"
command -v docker >/dev/null || die "docker não encontrado"
docker ps --format '{{.Names}}' | grep -q "$CID" || die "stack local fora do ar — rode: npx supabase start"
[ -f "$ROOT/.env.e2e.local" ] || die ".env.e2e.local ausente (veja scripts/e2e/LOCAL-E2E.md)"
# shellcheck disable=SC1091
source "$ROOT/.env.e2e.local"
case "${SUPABASE_URL:-}" in
  http://127.0.0.1*|http://localhost*|http://0.0.0.0*) ok "alvo local: $SUPABASE_URL" ;;
  *) die "RECUSANDO: SUPABASE_URL não é local ($SUPABASE_URL). Bootstrap nunca toca prod." ;;
esac

# ---- 1. reset: 52 migrations numa base limpa ----
c "supabase db reset (replay das migrations)"
TZ=America/Sao_Paulo npx --yes supabase db reset >/tmp/wc-bootstrap-reset.log 2>&1 \
  && ok "reset OK ($(grep -c 'Applying migration' /tmp/wc-bootstrap-reset.log) migrations)" \
  || die "reset falhou — veja /tmp/wc-bootstrap-reset.log"

# Gotcha nº1: o Kong fica com o upstream do auth STALE após o reset → 502 ao criar
# admin/usuários. Restart preventivo (custa ~5s, evita o gargalo de toda run).
docker restart "supabase_kong_world-cup-2026" >/dev/null 2>&1 && sleep 5 && ok "kong reiniciado (evita 502 no auth)" || true

# ---- 2. seed base (matches + settings; players vêm da migration 052) ----
c "Seed base (matches 104 + settings)"
docker exec -i "$CID" psql -U postgres -d postgres -q < "$ROOT/supabase/seed/01_matches.sql"  >/dev/null
docker exec -i "$CID" psql -U postgres -d postgres -q < "$ROOT/supabase/seed/03_settings.sql" >/dev/null
M=$(docker exec -i "$CID" psql -U postgres -d postgres -tAc "select count(*) from public.matches")
P=$(docker exec -i "$CID" psql -U postgres -d postgres -tAc "select count(*) from public.players")
[ "$M" = "104" ] || die "esperava 104 matches, achei $M"
ok "matches=$M  players=$P (canônicos via migration 052)"

# ---- 3. admin local ----
c "Admin local (00-setup-local.js)"
node "$ROOT/scripts/e2e/00-setup-local.js" >/dev/null && ok "admin garantido ($ADMIN_EMAIL)"

# ---- 4. massa sintética (~N users + palpites + enriquecimento) ----
c "Massa sintética ($USERS usuários)"
node "$ROOT/scripts/e2e/seed-scale.js" --users="$USERS" $ENRICH_FLAG $REALISTIC_FLAG
ok "seed-scale concluído"

# ---- 5. playout opcional ----
if [ "$PLAYOUT" = "1" ]; then
  c "Playout (joga o torneio, pontua todos)"
  docker exec -i "$CID" psql -U postgres -d postgres -q < "$ROOT/scripts/e2e/playout.sql" >/dev/null
  FIN=$(docker exec -i "$CID" psql -U postgres -d postgres -tAc "select count(*) filter (where finished) from public.matches")
  ok "playout aplicado ($FIN/104 finalizados)"
fi

# ---- 6. config local + serve opcional ----
c "build:config (aponta o front p/ LOCAL)"
npm run build:config >/dev/null && ok "config.js → $SUPABASE_URL"

if [ "$SERVE" = "1" ]; then
  c "Servindo src/ na :3000 (background)"
  (lsof -ti:3000 | xargs kill -9 2>/dev/null || true)
  nohup npx serve src -l 3000 >/tmp/wc-serve.log 2>&1 &
  sleep 2 ; ok "serve PID $! — http://localhost:3000"
fi

printf "\n\033[1;32m✅ Ambiente local pronto%s.\033[0m\n" "$([ "$PLAYOUT" = 1 ] && echo ' (pós-torneio/pontuado)' || echo ' (pré-torneio)')"
printf "   Lembre: \033[1mnpm run build:config\033[0m volta o front p/ PRODUÇÃO (lê .env).\n"
