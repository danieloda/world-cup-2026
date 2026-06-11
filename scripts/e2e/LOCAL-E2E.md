# E2E local — runbook (sem tocar produção)

Roda o bolão inteiro contra um Supabase **local** (Docker), isolado de produção.
O `.env` (produção) nunca é alterado: redirecionamos as vars via `.env.e2e.local`
(gitignored), e `dotenv` não sobrescreve env já setado no shell.

## Pré-requisitos
- Docker rodando
- `npx supabase` (CLI) — sem instalação global necessária
- Browsers do Playwright (`npx playwright install chromium`)

## 1. Subir o stack local
```bash
npx supabase start
npx supabase status -o env     # pega API_URL, ANON/PUBLISHABLE_KEY, SERVICE_ROLE_KEY locais
```

## 2. Aplicar o seed (NÃO é auto-aplicado)
`config.toml` aponta `[db.seed]` pra um `seed.sql` inexistente, então aplique à mão:
```bash
CID=supabase_db_world-cup-2026
docker exec -i $CID psql -U postgres -d postgres < supabase/seed/01_matches.sql      # 104 jogos + backfill de slots
docker exec -i $CID psql -U postgres -d postgres < supabase/seed/players_full.sql    # 1380 jogadores
docker exec -i $CID psql -U postgres -d postgres < supabase/seed/03_settings.sql     # settings
```
> O `01_matches.sql` já faz o backfill de `slot_home/away` no final — sem isso o
> mata-mata não resolve (a migration 005 backfilla antes do seed, em tabela vazia).

### 2.5 Grants de paridade com prod (CLI ≥ ~2.1xx)
A imagem local nova NÃO dá mais DML a `anon/authenticated/service_role` por
default privilege em tabela criada por `postgres` (ficam só TRUNCATE/REFERENCES/
TRIGGER) — sem isto TODO E2E falha com `permission denied for table …`. Prod
(projeto antigo) tem esses grants; replique:
```bash
docker exec -i $CID psql -U postgres -d postgres -c "
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated, service_role;"
```
> RLS continua mandando (grant ≠ policy). Re-rode após cada `db reset`.

## 3. (Opcional) Desativar triggers de alerta localmente
Evita POSTs ao edge de produção (Telegram). Inofensivos sem a key, mas para zero
contato externo:
```bash
docker exec -i $CID psql -U postgres -d postgres -c "
alter table public.matches        disable trigger trg_z_alert_orphan_predictions;
alter table public.matches        disable trigger trg_z_alert_unresolved_slots;
alter table public.predictions     disable trigger trg_z_alert_pred_overwrite;
alter table public.profiles        disable trigger trg_alert_signup_success;
alter table public.champion_picks  disable trigger trg_alert_champion_change;
alter table public.top_scorer_picks disable trigger trg_alert_scorer_change;
alter table public.predictions     disable trigger trg_alert_picks_complete;"
```

## 4. Apontar os scripts ao local
Crie `.env.e2e.local` (gitignored) com as credenciais do passo 1:
```bash
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_PUBLISHABLE_KEY="<ANON_KEY local>"
export SUPABASE_SERVICE_ROLE_KEY="<SERVICE_ROLE_KEY local>"
export BASE_URL="http://localhost:3000"
```
Os scripts E2E têm guard-rail: **abortam** se `SUPABASE_URL` não for local
(`lib/admin-client.js`), salvo `E2E_ALLOW_REMOTE=1`.

## 5. Gerar o frontend + servir
```bash
source .env.e2e.local && npm run build:config   # js/config.js aponta local
npx serve -l 3000 .                              # em outro terminal/bg
```

## 6. Rodar
```bash
source .env.e2e.local

node scripts/e2e/00-setup-local.js          # cria admin local (ADMIN_EMAIL/PASSWORD do .env)
node scripts/e2e/01-generate-tournament.js  # oráculo expected-tournament.json
node scripts/e2e/03-palpitar.js             # 10 users palpitam via UI
node scripts/e2e/04-admin-results.js        # time-warp + admin lança 104 resultados via UI
node scripts/e2e/05-audit.js                # audita a matemática vs v_leaderboard  (exit 0 = ok)
node scripts/e2e/06-ui-assert.js            # asserções no DOM (grupos/terceiros/ranking/histórico)

# Cenários determinísticos de empate + desempate FIFA (transação com rollback):
docker exec -i $CID psql -U postgres -d postgres < scripts/e2e/scenarios/tiebreak.sql

# Locks por horário + segurança:
node scripts/e2e/test-date-locks.js
node scripts/e2e/test-deadline-boundary.js  # trava véspera 23h59 BRT: INSERT/UPDATE palpite+campeão+artilheiro (14 checks)
node scripts/e2e/test-deadline-parity.js    # paridade do prazo: js/util.js ↔ SQL prediction_deadline() em 104 jogos + bordas (read-only)
node scripts/e2e/test-rls-hostile.js
node scripts/e2e/test-signup-flow.js        # exige enable_confirmations=true (já no config.toml)
node scripts/e2e/test-avatar-upload.js

# Estados temporais + UI + re-scoring (snapshot/restore; DESLIGAM alert triggers durante a mutação):
node scripts/e2e/test-temporal-states.js    # pré-torneio (vazio/aberto/TBD) + parcial (grupos done, KO TBD) no DOM (13 checks)
node scripts/e2e/test-ui-pages.js           # inicio (KPIs) + campeão/artilheiro ABERTO×TRAVADO (write via UI) + recent.json (15 checks)
node scripts/e2e/test-rescore-on-edit.js    # editar placar de grupo recomputa pontos+leaderboard; editar venc. de KO re-resolve slot (7 checks)

# Features novas (gráfico de evolução + bônus de artilheiro nos palpites da galera):
node scripts/e2e/test-historico-scorer.js   # "Palpites da galera": chip ⚽+N + pontos + popovers batem com o DB (12 checks, read-only)
node scripts/e2e/test-rank-chart.js         # bump chart: cria +10 voláteis → MUITAS viradas; legenda==v_leaderboard; modos/foco/hover; +historico em escala >1000 palpites (18 checks; limpa no finally)

# Cenários SQL determinísticos (transação c/ rollback — rode via psql no container):
CID=supabase_db_world-cup-2026
docker cp scripts/e2e/scenarios/scoring-sql.sql $CID:/tmp/ && docker exec $CID psql -U postgres -d postgres -f /tmp/scoring-sql.sql
#   ^ score_prediction (DB) vs canônico ag/ave/dg por fase + pênaltis (47 checks)
docker cp scripts/e2e/scenarios/tiebreak.sql $CID:/tmp/ && docker exec $CID psql -U postgres -d postgres -f /tmp/tiebreak.sql
docker cp scripts/e2e/scenarios/qualifier-bonus.sql $CID:/tmp/ && docker exec $CID psql -U postgres -d postgres -f /tmp/qualifier-bonus.sql
docker exec -i $CID psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/e2e/scenarios/reveal-publication.sql
#   ^ revelação pós-publicação do lacre (migration 060): publicado→vê pré-apito,
#     adiado→re-esconde, apito→fallback, escrita só service_role (12 checks)

# Cobertura estendida (cada um faz snapshot/restore do que mexe):
node scripts/e2e/test-storage-and-validation.js   # RLS de avatar Storage + validação de placar
node scripts/e2e/test-admin-ui-penalty.js         # campeão via pênaltis (UI) + clear/update-result
node scripts/e2e/test-admin-validation.js         # save bloqueia: KO empate s/ pênalti + marcadores≠placar (5 checks)
node scripts/e2e/test-fifa-tie-dom.js             # empate total no Grupo A → ordem FIFA no DOM
node scripts/e2e/test-odds.js                     # match_odds: RLS + badge no DOM
node scripts/e2e/test-concurrency-alerts.js       # writes paralelos (UNIQUE) + send_alert→alert_log
node scripts/e2e/test-cross-browser.js            # Chromium/Firefox/WebKit + viewport mobile
node scripts/e2e/test-session.js                  # persistência, token inválido, logout

# Unit + specs:
npm test
# Os specs em tests/e2e/predictions.spec.js exigem um usuário de teste confirmado COM avatar:
#   crie 'spec-user@testuser.com' (paid=false p/ não poluir o leaderboard) via Admin API,
#   depois rode com as env vars:
TEST_USER_EMAIL=spec-user@testuser.com TEST_USER_PASSWORD=SpecUser2026! \
  BASE_URL=http://localhost:3000 npx playwright test --workers=1
#   ^ use --workers=1 LOCAL: com fullyParallel+retries=0, vários logins simultâneos
#     contra o Supabase local estouram o timeout de 10s (flaky). Serial passa 20/20.
```

> Nota de UX (admin): a aba "Resultados → lançados" mostra só os **60 jogos mais recentes**
> (`admin.js`, `slice(0,60)`). Num torneio de 104, os ~44 resultados mais antigos não são
> editáveis/limpáveis pela UI — só via DB. Sem busca/paginação além de 60.

## 7. Cleanup
```bash
npm run build:config        # REGENERA js/config.js de volta pra PRODUÇÃO (lê .env)
npx supabase stop           # mantém volume; --no-backup pra descartar
```

## Gotchas resolvidos (por que algo pode falhar num ambiente novo)
- **slot_home NULL** → backfill agora no `01_matches.sql` (passo 2).
- **Gate de avatar**: users sem `avatar_url` são barrados em `complete-profile.html`.
  `03-palpitar.js` já seta um avatar default nos test users.
- **Picker de artilheiro** (admin) é um componente custom `.flag-select` (não `<select>`);
  `lib/admin-helpers.js` dirige via toggle+pick.
- **enable_confirmations** local: ligado em `config.toml` p/ espelhar prod (signup flow).
  Emails locais caem no Mailpit (http://127.0.0.1:54324).
