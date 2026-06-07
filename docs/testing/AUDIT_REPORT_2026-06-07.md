# Relatório de Auditoria de Testes — Pré-Copa

**Data:** 2026-06-07 · **Copa começa:** 2026-06-11 · **Usuários reais em prod:** 67 (63 pagantes)
**Ambiente:** Supabase local (Docker, paridade total com prod) · **Veredito:** ✅ **Lógica crítica da Copa 100% verde**

---

## 1. Sumário executivo

Rodada de testes mais completa do projeto até hoje. Reconstruí o ambiente local **do zero
com paridade de produção** (estava 13 migrations atrás), semeei **massa sintética em escala
de prod (70 usuários)** e rodei **todos os níveis de teste** — unitário → lógica de DB (SQL)
→ segurança (RLS) → E2E (Playwright + harness) → **carga/concorrência (novo)** → smoke
read-only de produção.

**Toda a lógica crítica da Copa passou:** pontuação, travas de prazo, RLS/segurança,
desempate FIFA, bônus de classificado, leaderboard e concorrência de deadline. As falhas
encontradas são **100% test-side** (testes de UI acoplados a estado/seletores antigos), não
bugs de produto — cada feature subjacente foi confirmada funcionando por outro teste verde.

| Indicador | Resultado |
|---|---|
| Suites verdes (núcleo crítico) | **18/18** |
| Asserções automatizadas verdes | **~800+** |
| Bugs de PRODUTO encontrados | **0** |
| Achados test-side (testes frágeis) | **7** (ver §4) |
| Paridade prod ↔ repo | ✅ confirmada (migration 052; players=1247 idêntico) |
| Gap de ambiente fechado | Local 039 → **052** (13 migrations) |

---

## 2. Matriz de cobertura por suite

| Nível | Suite | Resultado | O que cobre |
|---|---|---|---|
| Unit | `vitest` (17 arquivos) | **549/549 ✓** | bracket, scoring, thirds, util, deadline-parity, tz-invariance, rls-invariants, qualifier, raiox-render, alerts-wiring, lock-alerts, sintaxe/paths |
| Unit | coverage (catraca) | **✓** | bracket 99.3%/88.4% · scoring 100% · thirds 100% · util 58%/95% |
| DB lógica | `scoring-sql.sql` | **47/47 ✓** | `score_prediction` (DB) == canônico em TODAS as fases + pênaltis |
| DB lógica | `tiebreak.sql` | **12/12 ✓** | desempate FIFA, resolução de slots, idempotência, cascata, bônus campeão c/ pênaltis |
| DB lógica | `qualifier-bonus.sql` | **11/11 ✓** | ordem dos triggers, BPE/BP por fase, gating, idempotência, cumulativo r32→r16 |
| Segurança | `test-rls-hostile.js` | **17/17 ✓** | sem escalonamento, sem IDOR, palpite alheio invisível pré-kickoff, anti-cheat `points_earned`, audit trail |
| Prazo | `test-deadline-parity.js` | **10/10 ✓** | FE ↔ DB calculam o MESMO prazo ao minuto (104 jogos + bordas de fuso) |
| Prazo | `test-deadline-boundary.js` | **14/14 ✓** | trava 23h59 BRT em palpites/campeão/artilheiro (INSERT/UPDATE bloqueados pós-prazo) |
| E2E | Playwright `auth`+`predictions` | **21/21 ✓** | login, rotas protegidas, bracket sem vazar valores quebrados, ranking, sidebar |
| Render | `test-render-adversarial.js` | **90/90 ✓** | nenhuma página vaza `undefined`/`NaN`/`[object Object]`/`Invalid Date` nem quebra |
| Sessão | `test-session.js` | **4/4 ✓** | persistência, token corrompido→login, logout→login |
| Admin | `test-admin-validation.js` | **5/5 ✓** | save bloqueia KO empate s/ pênalti + marcadores≠placar |
| Validação | `test-storage-and-validation.js` | **4/4 ✓** | placar negativo/absurdo/não-inteiro rejeitado (CHECK 0-20) |
| Concorrência | `test-concurrency-alerts.js` | **✓** | 5 inserts paralelos → 1 ok + 4 UNIQUE-bloqueados; `send_alert`→`alert_log` |
| Avatar | `test-avatar-upload.js` | **✓** | upload p/ Storage + `avatar_url` no profile |
| Re-scoring | `test-rescore-on-edit.js` | **7/7 ✓** | editar placar recomputa pontos+leaderboard; editar KO re-resolve slot |
| Escala | auditoria de leaderboard (playout) | **✓** | `perfect` = **1129 = máximo teórico**; campeão +40; artilheiro +12; `not_paid` **excluído** |
| **Carga (NOVO)** | `test-load-concurrency.js` | **✓** | 60 usuários concorrentes: 60/60 inserts+updates (p50≈109ms), 0 cross-write, trava de prazo segura sob carga |
| Prod | `prod-smoke.js` (read-only) | **✓** | site no ar, paridade de schema, players=1247, settings críticas |

### Verificação independente da pontuação (escala)
O usuário `perfect` (palpita exato em tudo) somou **`match_pts = 1129`**, idêntico ao máximo
teórico calculado à mão a partir da tabela de pesos do README:

```
72×7 (grupos) + 16×9 (r32) + 8×19 (r16) + 4×32 (qf) + 2×50 (sf) + 1×25 (3º) + 1×76 (final) = 1129
```
Mais `+40` (campeão Senegal) e `+12` (artilheiro, 6 gols × 2 × mult). Confirma o modelo
aditivo end-to-end (`score_prediction` → trigger → `v_leaderboard`) em 6 523 palpites de 70 usuários.

---

## 3. Ambiente: gap fechado

**Antes:** o Supabase local estava **13 migrations atrás** (039 aplicada; repo na 052).
A tabela `client_errors` (047) sequer existia; odds/h2h/previsões vazios; só 11 usuários.
Testes contra esse ambiente **não eram realistas**.

**Agora (rebuild com paridade):**
- `supabase db reset` → **52 migrations** numa base limpa. A 052 (resync de elencos) rodou
  e inseriu o elenco canônico → **players = 1247, idêntico a produção**.
- Seed base (104 jogos + settings) + **70 usuários sintéticos** (61 pagantes) + 6 523 palpites
  + enriquecimento (72 odds, 72 h2h, 72 previsões, 5 pares team_h2h). Sem PII.
- Reproduzível em **1 comando**: `scripts/e2e/bootstrap-local.sh`.

A paridade foi confirmada pelo smoke read-only de prod (§2): mesmo conjunto de tabelas,
mesmo `players=1247`, mesmas settings críticas.

---

## 4. Achados (todos TEST-SIDE — nenhum bug de produto)

> Cada item abaixo é um **teste frágil**, não um defeito do app. A feature correspondente
> foi confirmada funcionando por outra suite verde (coluna "Confirmado por").

| # | Teste | Sintoma | Causa-raiz | Confirmado por |
|---|---|---|---|---|
| A1 | `tiebreak.sql`, `qualifier-bonus.sql` | `null user_id` ao rodar do zero | Exigem **profile admin** pré-existente (setup implícito) | Passam 12/12 e 11/11 após `00-setup-local.js` |
| A2 | `test-odds.js` | timeout em `.match[data-match-id=1]` | Move o jogo p/ data **fora da view padrão** (agrupada por data) + busca badge `.odd` que **migrou pro raio-x** | Probe: barra 1X2 48/29/23% + radar renderizam das odds seedadas |
| A3 | `test-temporal-states.js` (FASE B) | timeout em `.chip[data-group]` | Standings só renderizam com jogos **finalizados**; o setup da fase parcial não estabelece esse estado antes de navegar | `tiebreak.sql` prova standings/slots; `render-adversarial` 90/90 |
| A4 | `test-ui-pages.js` | timeout em `.group-card .team-name[data-team]` | `#classificacao` → aba Resultados, vazia sem jogos finalizados | idem A3 |
| A5 | `test-signup-flow.js` | timeout no submit do avatar (passo 6) | **Quirk de headless**: `setInputFiles` em input hidden não dispara `change` nativo (documentado no próprio teste). Passos 1-5 (signup→confirma→login→gate) passam | `test-avatar-upload.js` ✓ (upload real funciona) |
| A6 | `test-historico-scorer/rank-chart/fifa-tie-dom/admin-ui-penalty` | timeouts em seletores | Desenhados p/ rodar **após o golden-path** (01→06) com os 10 usuários do harness; frágeis standalone num rebuild limpo | `rescore-on-edit` 7/7, `admin-validation` 5/5, `tiebreak` C1-C3, leaderboard 1129 |
| A7 | `test-load-concurrency.js` (1ª execução) | só ~6/60 escritas | **A RLS funcionou**: `WITH CHECK points_earned IS NULL` bloqueia editar palpite já pontuado (anti-burla). Teste rodava no estado pós-playout | Corrigido (limpa o jogo-alvo no setup) → **60/60 ✓** |

### Tema comum
Vários testes de UI do harness assumem o **estado incremental** do ambiente do autor e que o
**golden-path (01→06) rodou antes**. Num rebuild **limpo com paridade de prod** eles quebram em
passos de espera de DOM. Não é regressão do app — é **manutenção de teste**. Recomendação em §6.

---

## 5. Avaliação de risco (pré-Copa)

| Área | Risco | Status |
|---|---|---|
| Pontuação (aditivo, todas as fases, pênaltis) | 🟢 Baixo | scoring-sql 47/47 + leaderboard = máximo teórico |
| Travas de prazo (palpite/campeão/artilheiro) | 🟢 Baixo | parity 10/10 + boundary 14/14 + RLS sob carga |
| RLS / segurança / anti-burla | 🟢 Baixo | hostil 17/17; `points_earned` imutável confirmado |
| Desempate FIFA + resolução de chaveamento | 🟢 Baixo | tiebreak 12/12 (pts>SG>GF>FIFA, cascata, idempotência) |
| Bônus de classificado (BPE/BP) | 🟢 Baixo | qualifier 11/11 |
| Concorrência no estouro de deadline (~70) | 🟢 Baixo | 60 concorrentes, p50≈109ms, 0 corrupção |
| Cadastro de novos usuários | 🟢 Baixo | signup passos 1-5 + avatar (teste dedicado) ✓ |
| Cobertura de UI por testes automáticos verdes | 🟡 Médio | núcleo coberto; harness de UI precisa de manutenção (§4/§6) |
| Entrega de alertas Telegram (edge) | ⚪ Não testado | depende de secrets; fora do escopo local |

---

## 6. Recomendações

1. **Manutenção do harness de UI (prioridade alta p/ próximas rodadas):** tornar
   `test-odds`, `test-temporal-states`, `test-ui-pages`, `test-fifa-tie-dom`,
   `test-admin-ui-penalty`, `test-historico-scorer`, `test-rank-chart` **robustos em rebuild
   limpo** — cada um deve estabelecer seu próprio estado (finalizar grupos quando precisar de
   standings) e usar os seletores atuais (raio-x no lugar de `.odd`; stepper/dots além de `.chip`).
2. **Pré-requisito explícito de admin** nos cenários SQL: o runbook já cria via
   `00-setup-local.js`; o `bootstrap-local.sh` faz isso automaticamente. Manter.
3. **CI:** hoje roda só unit + coverage. Considerar um job que suba Supabase local e rode os
   cenários SQL + RLS + deadline (os mais baratos e de maior valor), via `bootstrap-local.sh`.
4. **Smoke de prod read-only** (`prod-smoke.js`) como gate manual antes de cada deploy grande.
5. **Antes da Copa:** rodar `bootstrap-local.sh --playout` + a auditoria de leaderboard uma
   última vez na véspera, e o `prod-smoke.js` no dia.

---

## 7. Artefatos desta rodada

| Artefato | Caminho |
|---|---|
| Seeder de escala | `scripts/e2e/seed-scale.js` (novo) |
| Bootstrap 1-comando | `scripts/e2e/bootstrap-local.sh` (novo) |
| Teste de carga/concorrência | `scripts/e2e/test-load-concurrency.js` (novo) |
| Smoke read-only de prod | `scripts/e2e/prod-smoke.js` (novo) |
| Playout (joga o torneio) | `scripts/e2e/playout.sql` (gerado) |
| Roster sintético | `scripts/e2e/sim-roster.json` (gerado) |
| Oráculo do torneio | `scripts/e2e/expected-tournament.json` (gerado) |
| Plano de testes | `docs/testing/TEST_PLAN.md` |
| Contexto do projeto | `docs/testing/PROJECT_CONTEXT.md` |
| Setup do ambiente | `docs/testing/ENVIRONMENT.md` |
| Logs brutos | `/tmp/wc-test-logs/` |
