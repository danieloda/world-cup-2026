#!/usr/bin/env bash
# ============================================================================
# seed-demo-r32.sh — Demo "COPA EM ANDAMENTO" (grupos + 32-avos jogados).
# ============================================================================
# Monta um ambiente LOCAL para MOSTRAR: comparação palpite × resultado, ranking
# e histórico — com ~70 palpiteiros HUMANOS (nomes/palpites realistas, sem perfis
# de teste, sem clone perfeito do oráculo) e um estado coerente:
#
#   • Grupos (1-72) + 32-avos (73-88)  → JOGADOS, pontuados, no passado
#   • Oitavas (89-96) em diante         → AINDA NÃO COMEÇARAM (slots já resolvidos)
#   • timeline real: jogos passados no passado, próximos no futuro (date-gating ok)
#
# Compõe blocos já testados; NUNCA toca prod (guard-rail local em cada script).
#
# USO
#   ./scripts/dev/seed-demo-r32.sh                # 70 usuários + serve na :3000
#   ./scripts/dev/seed-demo-r32.sh --users=100    # outra escala
#   ./scripts/dev/seed-demo-r32.sh --no-serve     # não sobe o servidor
#
# Volta o front p/ PRODUÇÃO depois:  npm run build:config
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
CID="supabase_db_world-cup-2026"
SERVE=1 ; USERS=70

for arg in "$@"; do
  case "$arg" in
    --no-serve) SERVE=0 ;;
    --users=*) USERS="${arg#*=}" ;;
    *) echo "flag desconhecida: $arg" ; exit 2 ;;
  esac
done

c(){ printf "\n\033[1;34m▶ %s\033[0m\n" "$1"; }
ok(){ printf "\033[32m  ✓ %s\033[0m\n" "$1"; }
die(){ printf "\033[31m  ✗ %s\033[0m\n" "$1"; exit 1; }
psql(){ docker exec -i "$CID" psql -U postgres -d postgres -tAq "$@"; }

# ---- 0. env local + guard-rail ----
[ -f "$ROOT/.env.e2e.local" ] || die ".env.e2e.local ausente (veja scripts/e2e/LOCAL-E2E.md)"
set -a ; source "$ROOT/.env.e2e.local" ; set +a   # exporta p/ os scripts node filhos
case "${SUPABASE_URL:-}" in
  http://127.0.0.1*|http://localhost*|http://0.0.0.0*) : ;;
  *) die "RECUSANDO: SUPABASE_URL não é local ($SUPABASE_URL)." ;;
esac
docker ps --format '{{.Names}}' | grep -q "$CID" || die "stack local fora do ar — rode: npx supabase start"

# ---- 1. base limpa + ~N palpiteiros HUMANOS + palpites (pré-torneio) ----
c "Base + $USERS palpiteiros humanos (bootstrap --realistic)"
"$ROOT/scripts/e2e/bootstrap-local.sh" --users="$USERS" --realistic

# ---- 1b. conta 'Você' ANTES do playout (p/ o trigger de scoring pontuá-la junto) ----
# A conta tem avatar (pula o gate de foto) e palpites humanos (skill 0.5) → meia-tabela.
c "Conta de navegação (Você) — antes do playout p/ ser pontuada"
node "$ROOT/scripts/e2e/seed-my-account.js"

# ---- 2. joga GRUPOS + 32-avos (ids 1-88); oitavas+ ficam abertas, slots resolvem ----
c "Playout parcial: grupos + 32-avos (oitavas em diante: aberto)"
node "$ROOT/scripts/e2e/gen-playout-r32.js"
docker exec -i "$CID" psql -U postgres -d postgres -q < "$ROOT/scripts/e2e/playout-r32.sql" >/dev/null
FIN=$(psql -c "select count(*) filter (where finished) from public.matches;")
[ "$FIN" = "88" ] || die "esperava 88 jogos finalizados (grupos+32-avos), achei $FIN"
ok "88/104 finalizados (grupos 1-72 + 32-avos 73-88); oitavas 89-96 abertas"

# ---- 3. timeline coerente: jogados→passado, abertos→futuro ----
# (o histórico/RLS revelam por match_date<=now; sem isto os cards apareceriam abertos)
c "Timeline 'Copa em andamento' (preset-inprogress --on)"
node "$ROOT/scripts/e2e/preset-inprogress.js" --capture >/dev/null
node "$ROOT/scripts/e2e/preset-inprogress.js" --on

# ---- 4. campeão/artilheiro travados (torneio já começou) + admin fora do ranking ----
psql -c "update public.settings set value='\"2020-01-01T00:00:00Z\"'::jsonb where key='deadline_champion_scorer';" >/dev/null
psql -c "update public.profiles set paid=false where is_admin;" >/dev/null   # admin não é participante
ok "campeão/artilheiro travados + admin fora do ranking de participantes"

# ---- 5. front → LOCAL + serve ----
c "build:config (aponta o front p/ LOCAL)"
npm run build:config >/dev/null && ok "config.js → $SUPABASE_URL"

if [ "$SERVE" = "1" ]; then
  (lsof -ti:3000 | xargs kill -9 2>/dev/null || true)
  nohup npx serve src -l 3000 >/tmp/wc-serve.log 2>&1 &
  sleep 2 ; ok "serve PID $! — http://localhost:3000"
fi

# ---- resumo ----
PAID=$(psql -c "select count(*) from public.profiles where paid;")
LEAD=$(psql -c "select count(*) from public.v_leaderboard;")
TOP=$(psql -c "select full_name||' — '||total_pts||' pts' from public.v_leaderboard order by total_pts desc limit 1;")
printf "\n\033[1;32m✅ Demo pronta — Copa em andamento (grupos + 32-avos jogados).\033[0m\n"
printf "   Ranking: %s pagantes · líder: %s\n" "$LEAD" "$TOP"
printf "   App:     http://localhost:3000\n"
printf "   Login (participante):  eu@local.test  /  Palpite2026!\n"
printf "   Login (admin):         %s  /  %s\n" "$ADMIN_EMAIL" "$ADMIN_PASSWORD"
printf "   Voltar o front p/ PROD:  npm run build:config\n"
