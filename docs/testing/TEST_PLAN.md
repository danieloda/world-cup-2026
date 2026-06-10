# Plano de Testes — SBC 2026

> A estratégia: o que testamos em cada nível, por quê, e como rodar. Pirâmide do mais
> rápido/barato (unit) ao mais caro/realista (E2E + carga + prod). Veja resultados da
> última rodada em `AUDIT_REPORT_2026-06-07.md`.

## Filosofia

1. **A lógica crítica é testada nas DUAS pontas** (SQL no DB *e* JS no front) — e a paridade
   entre elas é testada explicitamente. Bug não pode depender de qual cópia você olhou.
2. **A variável que quebra é variada de propósito** (ex.: fuso horário). Teste que fixa a
   variável quebradiça esconde o bug — por isso há testes de invariância (TZ, paridade).
3. **RLS é a única fronteira de confiança** → tem suite hostil dedicada.
4. **Ambiente de teste = paridade de prod** (mesmas 52 migrations, players 1247, escala ~70).
5. **Nunca tocar produção** nos testes destrutivos (guard-rails em `lib/admin-client.js`).

## Níveis

### Nível 1 — Unitário (vitest, jsdom) · ~6s
Lógica PURA: `bracket`, `scoring`, `prize` (desempate de participantes + rateio),
`thirds-assign`, `util`, `fifa-rank`, `qualifier`, `raiox` render, paridade de
prazo/scoring, invariância de fuso, invariantes de RLS, sintaxe/paths.
Desde 2026-06-10 também: `card-results` (classificação dos cards palpite×resultado
+ paridade card↔replay), `progression-core` (replay do ranking; fim de série ==
total do leaderboard), `chart-utils` (posições/timeline/faixas dos gráficos),
`standings-tiebreak` (cada nível do desempate pts→SG→GF→FIFA isolado),
`leaderboard-parity` (ORDER BY do v_leaderboard ↔ prize.js) e
`integrity-guards` (cron do snapshot + fórmula de prazo + UNIQUEs anti-duplicata).
- **Rodar:** `npm test` · cobertura com catraca: `npm run test:coverage`
- **Gate:** 650 testes verdes + thresholds por arquivo (não podem cair). Módulos puros
  no escopo de cobertura: `bracket`, `card-results`, `chart-utils`, `prize`,
  `progression-core`, `scoring`, `thirds-assign`, `util`.
- **Paridade JS↔SQL:** `scoring-parity.test.js` parseia a ÚLTIMA def SQL de cada função.
  Ao adicionar uma migration que redefine `score_prediction`/etc., **atualize a sentinela**
  do número da migration nesse teste (ex.: pênaltis cravados = migration **056**).

### Nível 2 — Lógica de DB (psql, transação com ROLLBACK) · ~10s
Os cálculos no PostgreSQL, independentes da implementação JS. Não deixam resíduo.
- `scenarios/scoring-sql.sql` — `score_prediction` vs canônico (47 checks).
- `scenarios/tiebreak.sql` — desempate FIFA, slots, cascata, bônus campeão (12 checks).
- `scenarios/qualifier-bonus.sql` — BPE/BP, ordem de triggers, gating (11 checks).
- **Rodar:** `docker exec -i supabase_db_world-cup-2026 psql -U postgres -d postgres -f /tmp/<arq>.sql`
- **Pré-requisito:** profile admin existente (`00-setup-local.js` ou `bootstrap-local.sh`).

### Nível 3 — Segurança / RLS (Node, cliente anon) · ~30s
- `npm run test:rls` (`test-rls-hostile.js`) — 17 ataques: escalonamento, IDOR, spoof,
  anti-burla `points_earned`, visibilidade pré-kickoff, audit trail.
- `test-deadline-boundary.js` / `test-deadline-parity.js` — travas 23h59 BRT + paridade FE↔DB.
- `test-storage-and-validation.js` — CHECK de placar + RLS de Storage.
- `npm run test:integrity` (`test-integrity-snapshot.js`) — roda o snapshot/verify REAIS
  num sandbox tmp contra o DB local (só leitura): completude dos palpites travados
  (paridade com a fórmula de prazo de `util.js`), formato canônico, idempotência e
  detecção de adulteração na cadeia real do repo.
- `npm run test:xss` (`test-xss-hostile.js`) — **stored XSS** via `full_name` (único campo
  de texto livre do usuário, renderizado para todos). Cria um usuário HOSTIL com payload
  no nome (quebra de tag + `<img onerror>` + `<svg onload>`), navega como uma VÍTIMA e
  prova que o nome é **sempre escapado** (ranking, galera do histórico, gráficos). Tem
  controle negativo verificado: remover um `escapeHtml` faz a sonda falhar. Precisa do
  dev server (:3000).

### Nível 4 — E2E de UI (Playwright) · ~30s-2min
- **Specs estáveis:** `tests/e2e/auth.spec.js` + `predictions.spec.js` (21 testes).
  Rodar: `TEST_USER_EMAIL=sim-001@bolao.test TEST_USER_PASSWORD='SimUser2026!' npx playwright test --workers=1`
- **Render adversarial:** `npm run test:render` — nenhuma página vaza `undefined/NaN/...` (90 checks).
- **Harness de UI — standalone** (rodam após `bootstrap-local.sh`, estabelecem o próprio
  estado): `test-odds`, `test-fifa-tie-dom`, `test-temporal-states`, `test-ui-pages`,
  `test-signup-flow`, `test-session`, `test-render-adversarial`, etc. **Todos verdes.**
- **Harness de UI — golden-path** (exigem os usuários + oráculo do harness): `test-historico-scorer`,
  `test-rank-chart`, `test-admin-ui-penalty`. Rodar **após `node scripts/e2e/seed-harness-state.js`**
  (monta o estado do harness via DB em ~30s). **Todos verdes.**

### Nível 5 — Golden-path E2E (harness completo) · ~10min
Duas formas de montar o estado do harness (10 usuários + oráculo wc2026-e2e-v1 + playout):
- **Rápido (DB):** `node scripts/e2e/seed-harness-state.js` (~30s). Pré-requisito dos 3
  testes de asserção do golden-path acima. Reseta antes se os matches já estiverem jogados.
- **Completo (UI real):** `00-setup-local → 01-generate → 03-palpitar (UI) → 04-admin-results
  (time-warp + 104 resultados via UI) → 05-audit → 06-ui-assert`. Valida o **caminho de escrita
  pela UI**; lento (~10min); rode antes de releases grandes.

### Nível 6 — Carga / Concorrência (Node) · ~30s · **NOVO**
- `test-load-concurrency.js` — **estouro de deadline**: ~60 usuários concorrentes no mesmo
  jogo (login + insert + update) + trava sob carga. Mede latência (p50/p95) e integridade.
- `test-concurrency-alerts.js` — inserts paralelos contra UNIQUE + `send_alert`.

### Nível 7 — Smoke de Produção (read-only) · ~5s
- `prod-smoke.js` — site no ar + paridade de schema prod↔repo + números + settings +
  **sem jogador duplicado** (api_player_id único, elencos 26–27). **Só lê** (zero escrita).
- `prod-verify.js` (`npm run verify:prod`) — irmão **pesado**: recompute independente
  (via `src/js/scoring.js`) da pontuação de TODO palpite e do ranking de TODO pagante,
  comparado ao que o banco gravou. Pega trigger de scoring que falhou num jogo. Campeão
  derivado da final (prod não tem oráculo). Compartilha `lib/recompute.js` com o audit
  local (`verify-data.mjs`) — mesma matemática nas duas pontas, sem drift. **Só lê.**

### Nível 8 — Monitoramento sintético durante a Copa · contínuo · **NOVO**
`.github/workflows/monitor-prod.yml` vigia produção sozinho e alerta no Telegram **só em
falha** (testing in production, read-only):
- **smoke a cada 30 min** (`prod-smoke.js`) — site no ar + schema + duplicatas.
- **verify toda madrugada 03:15 BRT** (`prod-verify.js`) — recompute pesado.
- Alerta via `notify-telegram.js` (só as linhas de falha; degrada sem secrets).
- Reusa os secrets do integrity-snapshot (`SUPABASE_URL` var + `SERVICE_ROLE`/`TELEGRAM`).
- **Desligar após a final** (~20/jul): Actions → Monitor Prod → Disable workflow.

## Como rodar tudo (ordem recomendada)

> **Baseline por fase (não dá pra ter os dois estados ao mesmo tempo):** specs de
> palpite + deadline-boundary querem **pré-torneio** (jogos abertos); histórico/ranking/
> scoring querem **golden-path** (datas no passado). Por isso o run completo tem 2 ondas.

```bash
CID=supabase_db_world-cup-2026

# 0. Ambiente local com paridade de prod
./scripts/e2e/bootstrap-local.sh --serve        # pré-torneio + servidor :3000
#   --playout → joga o torneio (pontuado, p/ ranking/scoring; histórico fica em PRÉVIA)
# ⚠️ Se o bootstrap falhar com 502 ao criar admin/usuários: o db reset deixou o Kong
#    com o auth stale. Rode e refaça os passos pós-reset:
docker restart "$CID"_kong 2>/dev/null || docker restart supabase_kong_world-cup-2026

# 1-2. Unit + DB (rápidos; independem do estado)
npm test && npm run test:coverage
for s in scoring-sql tiebreak qualifier-bonus; do
  docker cp scripts/e2e/scenarios/$s.sql $CID:/tmp/ && docker exec $CID psql -U postgres -d postgres -f /tmp/$s.sql
done

# ─── ONDA A: PRÉ-TORNEIO (jogos abertos) ───
source .env.e2e.local
npm run test:rls
node scripts/e2e/test-deadline-parity.js
node scripts/e2e/test-deadline-boundary.js     # monta o jogo "vencido" como HOJE (robusto à meia-noite)
npm run test:render
TEST_USER_EMAIL=sim-001@bolao.test TEST_USER_PASSWORD='SimUser2026!' npx playwright test --workers=1
node scripts/e2e/test-temporal-states.js       # exige baseline PONTUADO p/ a FASE B → rode após `--playout`
node scripts/e2e/test-ui-pages.js && node scripts/e2e/test-odds.js && node scripts/e2e/test-fifa-tie-dom.js
node scripts/e2e/test-signup-flow.js && node scripts/e2e/test-session.js

# ─── ONDA B: GOLDEN-PATH (datas no passado → histórico revela cards reais) ───
docker exec -i $CID psql -U postgres -d postgres -q < supabase/seed/01_matches.sql   # volta ao pré-torneio
docker exec -i $CID psql -U postgres -d postgres -q < supabase/seed/03_settings.sql
node scripts/e2e/seed-harness-state.js                                                # monta o golden-path
node scripts/e2e/test-historico-scorer.js && node scripts/e2e/test-rank-chart.js
node scripts/e2e/test-admin-ui-penalty.js && node scripts/e2e/06-ui-assert.js

# Carga + smoke de prod (este SEM source .env.e2e.local — usa .env de prod, só leitura)
node scripts/e2e/test-load-concurrency.js --users=60
node scripts/e2e/prod-smoke.js
```

## Gates (o que bloqueia um deploy)

| Gate | Onde | Bloqueia? |
|---|---|---|
| `npm test` + coverage | CI (GitHub Actions) | ✅ automático no push |
| `test:rls` + `test:render` | manual antes do deploy | recomendado |
| Cenários SQL (scoring/tiebreak/qualifier) | manual / CI futuro | recomendado |
| `prod-smoke.js` | manual após deploy | recomendado |

## Convenções de teste

- **Determinismo:** PRNG semeado (`lib/prng.js`); oráculo em `expected-tournament.json`.
- **Isolamento:** scripts destrutivos abortam se a URL não for local (`E2E_ALLOW_REMOTE=1` força — não use).
- **Limpeza:** cada teste faz snapshot/restore do que muta; usuários sintéticos usam prefixos
  (`sim-`, `test-`) e são removidos no fim.
- **Estado:** muitos testes de UI precisam de jogos **finalizados** (standings) — use
  `--playout` ou rode o golden-path antes.
