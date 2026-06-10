# 🚨 Runbook de Operação — Copa 2026

> Como agir e onde olhar quando algo dá errado **durante a Copa**. Escrito para o
> momento de pressão: vá direto ao sintoma na seção **6 (Playbooks)**. As seções
> 1–5 são o mapa; a 7 é o que **nunca** fazer; a 9 é a rotina diária.
>
> Companheiro técnico: `docs/testing/` (como a coisa é testada) e
> `docs/testing/PROJECT_CONTEXT.md` (arquitetura). Este doc é o **operacional**.

---

## 1. Mapa de 30 segundos (onde está cada coisa)

| O quê | Onde |
|---|---|
| **Site (usuários)** | https://superbolaocopa.netlify.app |
| **Banco / Auth / Edge** | Supabase projeto `dnhnzmdqqvvvphiijevl` → dashboard supabase.com |
| **Deploy** | Netlify (publica `src/`). **Push na `main` = deploy automático.** |
| **Monitoramento automático** | GitHub Actions → workflow **Monitor Prod** (smoke 30min + verify madrugada) |
| **Alertas** | Grupo do **Telegram** (bot via edge `telegram-alert`) |
| **Erros de JS dos usuários** | Tabela `public.client_errors` + digest diário no Telegram |
| **Trilha de integridade** | `integrity/` no repo (snapshot diário, hash encadeado) |
| **Código da lógica** | `src/js/` (front) + `supabase/migrations/` (SQL) — **precisam concordar** |
| **Credenciais locais** | `.env` (PROD, read-only nos scripts) e `.env.e2e.local` (LOCAL) |

**Quem é o usuário:** ~75 cadastrados, fuso **Brasil (BRT, UTC-3)**. A Copa começa **11/jun/2026**.

---

## 2. Onde olhar PRIMEIRO (ordem de triagem)

Quando "algo está errado", cheque nesta ordem — do sinal mais barato ao mais profundo:

1. **Telegram** — o alerta já diz o quê? (resultado lançado, clímax, erro de JS, monitor falhou).
2. **GitHub Actions → Monitor Prod** — último smoke/verify passou? Falha aqui = problema real em prod.
   `gh run list --workflow=monitor-prod.yml --limit 5`
3. **O site abre?** `node scripts/e2e/prod-smoke.js` (read-only, ~5s) — site no ar + schema + duplicatas.
4. **Os números batem?** `npm run verify:prod` (read-only) — recompute de TODA a pontuação e ranking.
5. **Erros no navegador dos usuários?** Tabela `client_errors` no SQL Editor (query na seção 5).
6. **Supabase dashboard** → Logs (Postgres / Edge / Auth) e Database → Health, se 1–5 não explicaram.

> **Regra de ouro:** o `verify:prod` é o juiz final de "a pontuação está certa?". Se ele passa,
> os números que o usuário vê estão corretos — não importa o que alguém ache que viu.

---

## 3. O que TEM que funcionar 100% (caminhos críticos)

| Caminho | Como funciona (resumo) | Teste que protege |
|---|---|---|
| **Bloqueio de palpite** | Trava **23h59 BRT da véspera** (`prediction_deadline()`, migr. 023 = `util.js`). RLS é a fronteira real. | `deadline-parity`, `test:rls`, `date-tz-*` |
| **Lançar resultado** | `finished=true` dispara cascata: resolve slots → re-score → bônus classificado → alertas. | `tiebreak.sql`, `verify-data`, `test-rescore-on-edit` |
| **Pontuação** | Aditiva (placar + classificado + artilheiro + campeão). SSOT em 3 cópias que concordam. | `scoring*`, `scoring-sql`, `verify:prod` |
| **Ranking + desempate** | `v_leaderboard` (só pagantes) ordena por pts → exatos → V+S. | `prize`, `leaderboard-parity`, `standings-tiebreak` |
| **Grupos → mata-mata** | Com grupos cheios, `resolve_match_slots()` popula o KO (pts>SG>GF>FIFA, cascata). | `bracket`, `thirds-assign`, `tiebreak.sql` |
| **Sem duplicata de jogador** | `unique` em players/predictions/player_goals; prod auditado. | `integrity-guards`, `prod-smoke` |

---

## 4. Calendário dos robôs (tudo BRT = UTC−3)

| Hora BRT | Workflow | Faz o quê | Se falhar |
|---|---|---|---|
| a cada **30 min** | Monitor Prod (smoke) | site no ar + schema + duplicatas | alerta no Telegram + e-mail do GitHub |
| **03:00** | Refresh Odds | atualiza odds (Raio-X) | só perde enriquecimento; **não** afeta pontuação |
| **03:10** | Refresh Predictions / Integrity Snapshot | previsões do Raio-X / carimba palpites travados | Raio-X desatualiza / snapshot do dia não sai |
| **03:15** | Monitor Prod (verify) | recompute de pontuação + ranking | **alerta — investigar (seção 6.E)** |
| **05:00** | Refresh Recent Matches | jogos recentes p/ "forma" | só perde enriquecimento |
| **09:05** | (cron DB) digest de erros de JS | top erros do dia no Telegram | — |
| **seg 04:00** | Verify Fixtures | confere tabela de jogos vs fonte | drift de fixture |

> Falha num **Refresh*** raramente é urgente (só afeta o Raio-X informativo). Falha no
> **Monitor Prod verify** é a que importa: significa que a pontuação divergiu do recompute.

---

## 5. Caixa de ferramentas de diagnóstico (tudo READ-ONLY)

```bash
# Saúde rápida de prod (site + schema + duplicatas) — ~5s
node scripts/e2e/prod-smoke.js

# Auditoria PESADA: recomputa pontuação de TODO palpite e ranking de TODO pagante
# vs o que o banco gravou. É o juiz de "os números estão certos?".
npm run verify:prod

# Integridade da cadeia de snapshots (prova que palpite travado não foi mexido)
npm run integrity:verify
```

**Queries read-only úteis no Supabase → SQL Editor** (nunca escrevem):

```sql
-- Erros de JS reportados pelos navegadores nas últimas 24h
select created_at, message, page, count(*) over (partition by message) as freq
from public.client_errors
where created_at > now() - interval '24 hours'
order by created_at desc limit 50;

-- Jogos lançados recentemente (confere placar/pênalti/status)
select id, stage, team_home, team_away, actual_home, actual_away, pen_winner,
       finished, status, finished_at
from public.matches
where finished = true
order by finished_at desc nulls last limit 20;

-- Vagas de mata-mata ainda NÃO resolvidas (slot preso) — deveria ser 0 após grupos
select id, stage, team_home, team_away, slot_home, slot_away
from public.matches
where stage <> 'group'
  and (team_home ~ '^[0-9WL]' or team_away ~ '^[0-9WL]'
       or team_home like '%/%' or team_away like '%/%')
order by id;

-- Topo do ranking (o que a UI mostra)
select full_name, total_pts, match_pts, qualifier_pts, scorer_pts, champion_pts,
       exact_count, winner_sg_count
from public.v_leaderboard order by total_pts desc limit 15;
```

---

## 6. Playbooks por sintoma

> Formato: **sintoma → diagnóstico → correção → verificação**. Não pule a verificação.

### A. "O site não abre / tela branca"
- **Diagnóstico:**
  1. `node scripts/e2e/prod-smoke.js` — `login.html` responde 200?
  2. Netlify dashboard → último deploy: **published** ou **failed**?
  3. Console do navegador (F12): erro de `import` apontando para **esm.sh**? → o supabase-js é
     carregado de CDN; se o esm.sh cair, o app inteiro cai junto (risco conhecido).
- **Correção:**
  - Deploy quebrado → reverter: `git revert <commit>` + push (deploy automático).
  - esm.sh fora do ar → não há fix instantâneo sem vendorizar; confirme em status do esm.sh e
    aguarde, OU (pós-incidente) self-host do supabase-js em `src/vendor/`.
- **Verificação:** `prod-smoke` verde + abrir o site numa aba anônima.

### B. "Usuário não consegue salvar palpite"
- **Diagnóstico (a ordem importa):**
  1. O jogo **já travou**? Bloqueio é **23h59 BRT da véspera** — não no apito. Isso é **esperado**.
  2. Se ainda não travou e mesmo assim falha: peça print do erro. Erro de RLS = `points_earned`/
     prazo; erro de rede = sessão/CDN.
  3. **Clock skew:** se o relógio do dispositivo do usuário está muito errado, a UI pode mostrar
     "aberto" mas o servidor recusa (RLS usa o `now()` do servidor, que é a verdade).
- **Correção:** não há "destravar" um jogo individual sem mexer em `match_date` (não faça isso —
  contamina o histórico). Se for clock skew, oriente o usuário a corrigir a hora do aparelho.
- **Verificação:** `npm test` (deadline-parity continua verde) confirma que a regra não mudou.

### C. "O horário de bloqueio aparece errado"
- **Causa mais provável:** fuso. O prazo é calculado em BRT (UTC−3 fixo, sem horário de verão).
- **Diagnóstico:** `npm test` → `date-tz-invariance` + `deadline-parity` devem estar verdes.
  Compare `prediction_deadline(match_date)` (SQL) com o que a UI mostra para o mesmo jogo.
- **Correção:** se a regra divergiu entre `util.js` e a migration 023, **sincronize as duas** (a
  paridade é testada — o teste pega). Nunca mude uma ponta só.
- **Verificação:** `deadline-parity` verde.

### D. "Lancei um resultado errado / preciso corrigir um placar"
- **Bom saber:** **editar um resultado RE-PONTUA tudo** automaticamente (testado). Pode corrigir.
- **Correção (pelo painel admin):**
  1. Admin → aba de resultados → editar o placar/pênalti/gols do jogo.
  2. Salvar dispara a cascata de novo (re-score + slots + classificado).
  3. Jogo que **não deveria contar**? Use **"Anular jogo"** (status `void`) — ele para de pontuar
     sem apagar nada. Dá pra **reativar** depois.
- **Verificação:** `npm run verify:prod` — pontuação e ranking voltam a bater.

### E. "🚨 Monitor Prod (verify) falhou" — pontuação/ranking divergiu
- **É o alerta mais importante.** Significa: o banco gravou pontos diferentes do recompute independente.
- **Diagnóstico:**
  1. Rode `npm run verify:prod` localmente e leia as linhas com `✗` — elas dizem o usuário, o
     jogo, e `esperado X / banco Y`.
  2. Geralmente aponta para **um jogo** cujo trigger de scoring não rodou (ex.: resultado lançado
     durante uma falha momentânea do banco).
- **Correção:**
  - Reaplicar o scoring daquele jogo: no admin, **reabrir e salvar o mesmo resultado** (dispara o
    trigger de novo), OU rodar o recompute via RPC admin no SQL Editor se o jogo específico for
    conhecido (`recompute_*` — só admin).
  - Se for divergência da **view** (qualifier_pts view≠cache), recompute do cache de classificado.
- **Verificação:** `npm run verify:prod` → "✅ PROD CONFERE".

### F. "O mata-mata não populou / vaga ficou como '1A' / 'W89'"
- **Quando:** após o fim dos grupos, ou após lançar um resultado de KO.
- **Diagnóstico:** rode a query "vagas não resolvidas" da seção 5 — lista os slots presos.
  Causa comum: um grupo ainda **não está 100% finalizado** (resolve só roda com o grupo cheio),
  ou um time sem rank FIFA quebrou o desempate.
- **Correção:**
  1. Confirme que **todos** os jogos do(s) grupo(s) de origem estão `finished=true`.
  2. Reaplicar a resolução: lançar/reabrir-salvar o último resultado pendente dispara
     `resolve_match_slots()` em cascata.
  3. Time sem rank FIFA (slot preso por desempate) → conferir `team_fifa_rank` (deveria ter 48).
- **Verificação:** query de slots presos retorna **0 linhas**; `bracket` test verde localmente.

### G. "Jogador some / aparece duplicado / palpite de artilheiro quebrado"
- **Diagnóstico:** `prod-smoke` já checa "sem api_player_id duplicado" + "elencos 26–27".
  No SQL Editor, conte por time: `select team, count(*) from players group by team having count(*) <> 26;`
- **Correção:**
  - **NÃO rode `npm run sync:players`** (usa squads.json legado — reintroduz duplicata).
  - Overrides de elenco são **manuais e autoritativos** (ver memória do projeto). Um `resync`/
    `sync:squads` **reverteria** os ajustes de 09/jun — não rode sem intenção.
  - `top_scorer_picks.player_id` é `ON DELETE RESTRICT` — nada com palpite é apagável; reaponte
    o palpite para a linha canônica antes de remover qualquer duplicata.
- **Verificação:** `prod-smoke` verde.

### H. "Alertas do Telegram: spam, ou silêncio total"
- **Spam:** o trigger de `client_errors` tem dedupe por assinatura (~6h). Um erro de JS novo e
  recorrente pode estourar — corrija a causa (veja `client_errors`), não o alerta.
- **Silêncio (nada chega):** confira os **secrets** no GitHub (`TELEGRAM_TOKEN`,
  `TELEGRAM_CHAT_ID`) e nos secrets da edge function. O monitor só posta **em falha** — silêncio
  com tudo verde é o esperado.
- **Verificação:** dispare um teste — `gh workflow run "Monitor Prod"` e veja o run.

### I. "Usuários relatam erros estranhos na tela"
- **Diagnóstico:** query de `client_errors` (seção 5) — agrupe por `message` e `page`. O front
  reporta `window.onerror`/`unhandledrejection` automaticamente.
- **Correção:** reproduza local (`bootstrap-local.sh` + a página), corrija, rode os gates, deploy.
- **Verificação:** `test:render` (90 checks de "nenhuma página vaza undefined/NaN") + o erro some
  do `client_errors`.

---

## 7. NUNCA faça durante a Copa (gatilhos de catástrofe)

- ❌ **`admin_reset_picks()` / `admin_reset_matches()`** — APAGAM todos os palpites/resultados.
  São de setup pré-torneio. Rodar durante a Copa = perda total.
- ❌ **`npm run sync:players`** — reintroduz jogadores duplicados (squads.json é legado).
- ❌ **`resync`/`sync:squads` sem intenção** — reverte os overrides manuais de elenco de 09/jun.
- ❌ **Rodar scripts E2E destrutivos contra prod** — o guard `assertLocalTarget` recusa; **não**
  force com `E2E_ALLOW_REMOTE=1`.
- ❌ **Editar `match_date`** para "destravar" um palpite — contamina histórico e bloqueio.
- ❌ **Force-push na `main`** — quebra a cadeia de integridade (a prova de imutabilidade).
- ❌ **Mexer em uma ponta da lógica só** (`util.js` sem a migration, ou vice-versa) — a paridade
  é testada; sincronize as duas.

---

## 8. Mudança de emergência (hotfix → deploy)

Push na `main` = deploy no Netlify. O fluxo autorizado é **commit direto na main**, mas **rode os
gates antes** (push é irreversível para o usuário):

```bash
# 1. Reproduza e corrija local
./scripts/e2e/bootstrap-local.sh --serve     # ambiente local = paridade de prod

# 2. Gates mínimos antes de QUALQUER push
npm test && npm run test:coverage            # unit + catraca (650 testes)
npm run verify:prod                          # prod ainda consistente? (read-only)

# 3. Se a mudança toca render/segurança, rode também:
source .env.e2e.local
npm run test:render && npm run test:rls

# 4. Commit + push (deploy automático)
git add -A && git commit -m "fix(...): ..." && git push

# 5. Pós-deploy
node scripts/e2e/prod-smoke.js               # site no ar + schema
```

> **Migrations são aplicadas À MÃO** no Supabase **SQL Editor** (não há CLI/CI de migration).
> Se o hotfix exige SQL: aplique a migration no SQL Editor **e** versione o arquivo em
> `supabase/migrations/` no mesmo commit — senão `db reset` local diverge de prod.

---

## 9. Rotina diária sugerida (durante a Copa)

**Manhã (após a rodada da véspera ter sido lançada):**
1. Olhar o Telegram — algum alerta de erro ou do monitor?
2. `gh run list --workflow=monitor-prod.yml --limit 3` — verify da madrugada passou?
3. Se lançou resultados ontem: `npm run verify:prod` (confirma pontuação/ranking).

**Noite (antes de dormir, se houver jogos no dia seguinte):**
4. Confirmar que os resultados do dia foram lançados no admin (senão o bloqueio da próxima
   rodada e o ranking ficam defasados).
5. Rodada de mata-mata? Conferir a query de "vagas não resolvidas" (deve dar 0).

**Semanal:**
6. `npm run integrity:verify` — a cadeia de snapshots continua íntegra.

**No fim da Copa (~20/jul):**
7. **Desligar o Monitor Prod:** Actions → Monitor Prod → ⋯ → *Disable workflow*
   (senão o smoke roda a cada 30 min para sempre).

---

## 10. Glossário de "está tudo bem"

- **Telegram quieto** com tudo verde = bom (o monitor só fala em falha).
- **`prod-smoke` verde** = site no ar, schema em paridade, sem duplicata.
- **`verify:prod` verde** = todo palpite e todo ranking que o usuário vê estão corretos.
- **`integrity:verify` verde** = nenhum palpite travado foi adulterado.
- **Refresh* falhando** = só o Raio-X informativo desatualiza; **não** afeta pontuação.

> Se os quatro primeiros estão verdes, **o sistema está saudável** — independentemente de
> impressões. Quando em dúvida, rode os quatro e confie neles.
