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

### Nível 1 — Unitário (vitest, jsdom) · ~5s
Lógica PURA: `bracket`, `scoring`, `thirds-assign`, `util`, `fifa-rank`, `qualifier`, `raiox`
render, paridade de prazo/scoring, invariância de fuso, invariantes de RLS, sintaxe/paths.
- **Rodar:** `npm test` · cobertura com catraca: `npm run test:coverage`
- **Gate:** 549 testes verdes + thresholds por arquivo (não podem cair).

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

### Nível 4 — E2E de UI (Playwright) · ~30s-2min
- **Specs estáveis:** `tests/e2e/auth.spec.js` + `predictions.spec.js` (21 testes).
  Rodar: `TEST_USER_EMAIL=sim-001@bolao.test TEST_USER_PASSWORD='SimUser2026!' npx playwright test --workers=1`
- **Render adversarial:** `npm run test:render` — nenhuma página vaza `undefined/NaN/...` (90 checks).
- **Harness de UI** (`scripts/e2e/test-*.js`): sessão, admin, avatar, re-scoring, odds, etc.
  ⚠️ Vários assumem o **golden-path** (§ abaixo) ou estado finalizado — ver achados no AUDIT.

### Nível 5 — Golden-path E2E (harness completo) · ~10min
Fluxo ponta-a-ponta pela UI real, com oráculo determinístico:
```
00-setup-local → 01-generate-tournament → 03-palpitar (10 users via UI)
→ 04-admin-results (time-warp + 104 resultados via UI) → 05-audit (matemática vs v_leaderboard)
→ 06-ui-assert (DOM)
```
Valida o caminho de **escrita pela UI** + admin + auditoria. Lento; rode antes de releases grandes.

### Nível 6 — Carga / Concorrência (Node) · ~30s · **NOVO**
- `test-load-concurrency.js` — **estouro de deadline**: ~60 usuários concorrentes no mesmo
  jogo (login + insert + update) + trava sob carga. Mede latência (p50/p95) e integridade.
- `test-concurrency-alerts.js` — inserts paralelos contra UNIQUE + `send_alert`.

### Nível 7 — Smoke de Produção (read-only) · ~5s
- `prod-smoke.js` — site no ar + paridade de schema prod↔repo + números + settings.
  **Só lê** (zero escrita). Gate manual antes de deploy grande / no dia da Copa.

## Como rodar tudo (ordem recomendada)

```bash
# 0. Ambiente local com paridade de prod (1 comando)
./scripts/e2e/bootstrap-local.sh            # pré-torneio
#   --playout  → também joga o torneio (estado pontuado, p/ ranking/scoring)
#   --serve    → sobe o servidor estático na :3000

# 1-2. Unit + DB (rápidos, alto valor)
npm test && npm run test:coverage
CID=supabase_db_world-cup-2026
for s in scoring-sql tiebreak qualifier-bonus; do
  docker cp scripts/e2e/scenarios/$s.sql $CID:/tmp/ && docker exec $CID psql -U postgres -d postgres -f /tmp/$s.sql
done

# 3. Segurança + prazo
source .env.e2e.local
npm run test:rls
node scripts/e2e/test-deadline-parity.js
node scripts/e2e/test-deadline-boundary.js

# 4. E2E UI (precisa do servidor: bootstrap --serve, ou `npx serve src -l 3000`)
npm run test:render
TEST_USER_EMAIL=sim-001@bolao.test TEST_USER_PASSWORD='SimUser2026!' npx playwright test --workers=1

# 6. Carga
node scripts/e2e/test-load-concurrency.js --users=60

# 7. Smoke de prod (SEM source .env.e2e.local — usa .env de prod, só leitura)
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
