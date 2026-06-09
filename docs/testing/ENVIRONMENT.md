# Ambiente de Testes Local — Setup & Bootstrap

> Como ter um Supabase **local com paridade de produção** (mesmas 52 migrations, elenco
> canônico de 1247, escala ~70 usuários) — isolado de prod, reprodutível em 1 comando.
> Runbook detalhado de cada passo manual: `scripts/e2e/LOCAL-E2E.md`.

## Pré-requisitos

- **Docker** rodando.
- **`npx supabase`** (CLI baixada on-demand; não precisa instalar global). Verifique: `npx supabase --version`.
- **Playwright chromium:** `npx playwright install chromium`.
- **`.env.e2e.local`** (gitignored) apontando pro stack local:
  ```bash
  export SUPABASE_URL="http://127.0.0.1:54321"
  export SUPABASE_PUBLISHABLE_KEY="<ANON_KEY local>"      # npx supabase status -o env
  export SUPABASE_SERVICE_ROLE_KEY="<SERVICE_ROLE local>"
  export ADMIN_EMAIL="admin-e2e@local.test"
  export ADMIN_PASSWORD="AdminE2E2026!"
  export BASE_URL="http://localhost:3000"
  ```
  > As chaves locais são as **demo keys padrão** do Supabase e **persistem** entre `db reset`.

## Subir o stack (uma vez)

```bash
npx supabase start          # sobe os containers supabase_*_world-cup-2026
npx supabase status -o env  # pega as chaves locais p/ o .env.e2e.local
```

## Bootstrap em 1 comando (recomendado)

```bash
./scripts/e2e/bootstrap-local.sh                 # estado PRÉ-torneio (palpites abertos)
./scripts/e2e/bootstrap-local.sh --playout       # + joga o torneio (estado pontuado)
./scripts/e2e/bootstrap-local.sh --users=100     # outra escala
./scripts/e2e/bootstrap-local.sh --serve         # + sobe o servidor estático na :3000
./scripts/e2e/bootstrap-local.sh --no-enrichment # sem odds/h2h/previsões
```

O que ele faz (idempotente, com guard-rail que **aborta se a URL não for local**):
1. `supabase db reset` → aplica as **52 migrations** numa base limpa.
2. Seed base: `01_matches.sql` (104 jogos + backfill de slots) + `03_settings.sql`.
   *(players NÃO são semeados — a migration 052 já insere o elenco canônico de 1247.)*
3. `00-setup-local.js` → cria o admin local.
4. `seed-scale.js` → **70 usuários** sintéticos + 6 523 palpites + campeão/artilheiro +
   enriquecimento (odds/h2h/previsões). Gera `expected-tournament.json`, `sim-roster.json`, `playout.sql`.
5. `build:config` → aponta o front pra LOCAL.

## Estados do ambiente

| Estado | Como chegar | Bom para testar |
|---|---|---|
| **Pré-torneio** (real hoje) | `bootstrap-local.sh` | palpites (inputs abertos), travas/deadline, RLS, concorrência, Raio-X, signup |
| **Pós-resultados** (pontuado) | `bootstrap-local.sh --playout` ou aplicar `playout.sql` | ranking, scoring, leaderboard, gráfico, classificação/3ºs |
| **Golden-path** (datas no PASSADO) | `seed-harness-state.js` (após pré-torneio) | **histórico** (cards reais), `historico-scorer`, `rank-chart`, `admin-ui-penalty`, `06-ui-assert` |

> ⚠️ **O histórico revela por `match_date <= now()`** (não por `finished`). No `--playout` as datas
> canônicas da Copa (jun–jul) são **futuras** → o histórico mostra a **PRÉVIA** (cards desfocados),
> não cards reais. Para testar o DOM do histórico use o **golden-path** (`seed-harness-state.js`,
> que joga o torneio com datas no passado). Ver matriz de baseline por teste no TEST_PLAN.md.

Aplicar o playout manualmente a qualquer momento:
```bash
docker exec -i supabase_db_world-cup-2026 psql -U postgres -d postgres < scripts/e2e/playout.sql
```

## Credenciais úteis (local)

- **Admin:** `admin-e2e@local.test` / `AdminE2E2026!`
- **Usuários sintéticos:** `sim-001@bolao.test` … `sim-070@bolao.test` / `SimUser2026!`
  (perfis em `scripts/e2e/sim-roster.json`; os 10 primeiros são perfis-borda determinísticos:
  `perfect`, `not_paid`, `groups_only`, etc.)
- **Mailpit** (emails locais): http://127.0.0.1:54324 · **Studio:** http://127.0.0.1:54323

## Isolamento de produção (importante)

- Os scripts E2E **abortam** se `SUPABASE_URL` não for local (`lib/admin-client.js`,
  `bootstrap-local.sh`, `test-load-concurrency.js`). Só `prod-smoke.js` fala com prod — e **só lê**.
- `config.js` é **gitignored**; um config local nunca chega ao deploy (o Netlify gera o dele).
- O `.env` (prod) **nunca** é alterado pelo fluxo local (o shell sobrescreve via `source .env.e2e.local`).

## Voltar o front pra PRODUÇÃO

```bash
npm run build:config        # lê .env (prod) e regenera src/js/config.js
```
> Faça isso se for abrir o app local apontando pra prod, ou por higiene ao terminar.
> (Não é necessário pro deploy — o Netlify rebuilda o config dele.)

## Parar o stack

```bash
npx supabase stop           # mantém o volume; `--no-backup` descarta os dados
```

## Troubleshooting

| Sintoma | Causa / correção |
|---|---|
| Scripts abortam "SUPABASE_URL não é local" | Faltou `source .env.e2e.local` |
| **`502` / `AuthRetryableFetchError {}` ao criar admin/usuários** (00-setup, seed-scale) | **Kong ficou com o upstream do auth stale após o `db reset`.** Rode `docker restart supabase_kong_world-cup-2026` (espera ~5s) e refaça os passos pós-reset (admin → seed-scale → playout → build:config). É o gargalo nº 1 de qualquer run que começa com bootstrap. |
| `db reset` falha | Veja `/tmp/wc-bootstrap-reset.log`; confirme Docker + stack up |
| Mata-mata não resolve | Slots não backfillados — rode o seed `01_matches.sql` (o bootstrap faz) |
| Cenário SQL: `null user_id` | Falta o admin — rode `00-setup-local.js` (o bootstrap faz) |
| Standings/`.chip` vazios | Estado pré-torneio (sem jogos finalizados) — use `--playout` |
| **Histórico mostra a PRÉVIA mesmo com `--playout`** | Datas canônicas são futuras; o histórico revela por `match_date <= now()`. Use o golden-path (`seed-harness-state.js`, datas no passado). |
| Playwright login flaky | Use `--workers=1` no local (logins simultâneos estouram timeout) |
| `predictions.spec` falha sem jogos abertos (`.score-input`) | Estado 100%-jogado — rode os specs no **pré-torneio**, não no playout/golden-path. |
