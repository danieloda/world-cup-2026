# Documentação de Testes — SBC 2026

Documentação forte da suíte de testes do bolão, criada na rodada de endurecimento pré-Copa
(2026-06-07). Ponto de partida para qualquer rodada futura.

## Índice

| Doc | Para quê |
|---|---|
| **[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)** | Contexto amplo: arquitetura, modelo de dados, pontuação, segurança, triggers, gotchas. **Leia primeiro.** |
| **[TEST_PLAN.md](TEST_PLAN.md)** | Estratégia: os 7 níveis de teste, o que cada um cobre, como rodar, gates. |
| **[ENVIRONMENT.md](ENVIRONMENT.md)** | Como montar o ambiente local com paridade de prod (bootstrap em 1 comando). |
| **[AUDIT_REPORT_2026-06-07.md](AUDIT_REPORT_2026-06-07.md)** | Resultados da rodada: matriz de cobertura, achados, risco, recomendações. |

Runbook passo-a-passo (manual, complementar): [`scripts/e2e/LOCAL-E2E.md`](../../scripts/e2e/LOCAL-E2E.md)

## TL;DR — rodar a suíte

```bash
./scripts/e2e/bootstrap-local.sh          # ambiente local = paridade de prod (1 comando)
npm test && npm run test:coverage         # unit + catraca
source .env.e2e.local && npm run test:rls # segurança
node scripts/e2e/test-load-concurrency.js # carga (estouro de deadline)
node scripts/e2e/prod-smoke.js            # smoke read-only de prod (sem source!)
```

## Veredito da última rodada (2026-06-07)

✅ **Suíte inteira verde** — lógica crítica (pontuação, prazos, RLS, desempate FIFA, classificado,
leaderboard, concorrência) **e** todo o harness de UI. **0 bugs de produto.** Os 8 testes de UI
que eram frágeis num rebuild limpo foram **corrigidos** (ver AUDIT §4). Paridade prod↔repo
confirmada (migration 052; players=1247).

**2 caminhos de estado para os testes:**
- `bootstrap-local.sh` → estado sintético (pré-torneio). Roda os testes **standalone**.
- `seed-harness-state.js` → estado do golden-path (usuários + oráculo do harness, ~30s).
  Pré-requisito de `test-historico-scorer`, `test-rank-chart`, `test-admin-ui-penalty`.

## Scripts-chave (todos em `scripts/e2e/`)

| Script | Papel | Status |
|---|---|---|
| `bootstrap-local.sh` | Reconstrói o ambiente local com paridade de prod | **novo** |
| `seed-scale.js` | Semeia ~70 usuários + palpites + enriquecimento | **novo** |
| `seed-harness-state.js` | Estado do golden-path (10 users + oráculo do harness + playout) via DB | **novo** |
| `test-load-concurrency.js` | Estouro de deadline em escala (carga) | **novo** |
| `prod-smoke.js` | Gate read-only contra produção | **novo** |
| `playout.sql` | Joga o torneio e pontua todos (gerado) | gerado |
| `00-setup-local.js` … `06-ui-assert.js` | Golden-path E2E pela UI | existente |
| `scenarios/*.sql` | Cenários determinísticos de DB (scoring/tiebreak/qualifier) | existente |
| `test-rls-hostile.js`, `test-deadline-*.js`, … | Suites de segurança/prazo/UI | existente |
