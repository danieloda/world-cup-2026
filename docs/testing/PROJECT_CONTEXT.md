# Contexto do Projeto — SBC 2026 (Bolão Copa do Mundo)

> Mapa de referência do que existe e como funciona. Escrito para quem vai **testar**
> o sistema, mas serve como visão geral de arquitetura. Validado contra o código em 2026-06-07.

## 1. O que é

Bolão da Copa do Mundo 2026. Usuários palpitam placares dos 104 jogos, escolhem campeão e
artilheiro, e ganham pontos conforme acertam. Há ranking ao vivo, painel admin para lançar
resultados, e um "Raio-X" de contexto por confronto (odds, forma, H2H, eliminatórias).
**67 usuários reais** em produção; a Copa começa **11/jun/2026**.

- **Produção:** https://superbolaocopa.netlify.app (Netlify) + Supabase `dnhnzmdqqvvvphiijevl`
- **Fuso dos usuários:** Brasil (BRT, America/Sao_Paulo) — central para as travas de prazo.

## 2. Stack

| Camada | Tecnologia |
|---|---|
| Frontend | **Vanilla JS** (ES modules), HTML, CSS — **sem framework, sem build** (só `build:config`) |
| Backend | **Supabase**: PostgreSQL 17 + Auth + RLS + Storage + Edge Functions (Deno) |
| Deploy | Netlify (publica `src/`, gera `config.js` das env vars no build) |
| Alertas | Edge function `telegram-alert` (chamada por webhooks de DB) |
| Dados externos | API-Football (odds, h2h, previsões, elencos) via GitHub Actions agendadas |

**Implicação para testes:** a lógica de negócio vive em **2 lugares que precisam concordar**:
SQL (migrations) e JS (`src/js/`). A pontuação existe em 3 cópias (ver §5).

## 3. Páginas (src/*.html → src/js/pages/*.js)

| Página | Função |
|---|---|
| `login` / `signup` / `forgot-password` / `reset-password` / `complete-profile` | Auth + gate de avatar |
| `inicio` | Dashboard: KPIs, próximo jogo + countdown |
| `palpites-grupos` | Abas: **Palpites** (72 jogos) · **Resultados/Classificação** · **Terceiros** (1 grupo por vez via stepper) |
| `palpites-mata` | Palpites do mata-mata (bracket de 32 jogos) |
| `campeao-artilheiro` | Escolha de campeão + artilheiro (trava no `deadline_champion_scorer`) |
| `ranking` | Leaderboard + gráfico de evolução (bump chart) |
| `historico` | Jogos passados + "palpites da galera" |
| `admin` | Lançar resultados, gols, gerir usuários/pagamentos |
| `regras` | Regras de pontuação |
| `grupos` / `terceiros` | Redirects legados → `palpites-grupos.html#...` |

## 4. Modelo de dados (tabelas public)

| Tabela | Chave | Papel |
|---|---|---|
| `profiles` | id (=auth.uid) | full_name, email, **is_admin**, **paid**, avatar_url |
| `matches` | id (1-104) | stage, group_name, match_date, team_home/away, **slot_home/away**, actual_home/away, **pen_winner**, finished, status |
| `predictions` | id; **UNIQUE(user_id,match_id)** | pred_home/away (CHECK 0-20), pred_pen_winner, **points_earned** |
| `champion_picks` | user_id | team |
| `top_scorer_picks` | user_id | player_id (FK RESTRICT) |
| `players` | id | full_name, team, position, api_player_id (**1247** canônicos) |
| `player_goals` | id; UNIQUE(player_id,match_id) | gols por jogo (dirige bônus de artilheiro) |
| `user_qualifier_points` | user_id | cache do bônus de classificado (BPE/BP) + breakdown jsonb |
| `match_odds` / `match_h2h` / `team_h2h` / `match_predictions` | match_id/par | enriquecimento do Raio-X (jsonb) |
| `team_fifa_rank` | team (48) | ranking FIFA — **desempate** de grupos |
| `settings` | key | pool_name, fee_amount, **deadline_champion_scorer**, prize_split, pix_key, site_url, crons |
| `prediction_audit` | id | **trilha append-only** de toda escrita em palpite (defensibilidade) |
| `client_errors` | id | erros de JS reportados pelo front (migration 047) |
| `alert_log` | id | log de alertas enviados ao Telegram |

**Views:** `v_leaderboard` (pontos por usuário — **só pagantes**), `v_scorer_ranking`, `v_pool_stats`.

## 5. Sistema de pontuação (modelo ADITIVO — migration 022)

Cada componente certo soma. **Placar exato = `2·ag + ave + dg`.**

| Componente | Ganha quando |
|---|---|
| **AG** | cada lado cujo nº de gols você acertou (0, 1 ou 2 lados) → `+ag` por lado |
| **AVE** | acertou o resultado (vencedor/empate; no KO o empate decide por `pen_winner`) |
| **DG** | acertou o saldo de gols |

Pesos por fase (AG/AVE/DG → exato): Grupos 1/4/1→**7** · R32 1/6/1→**9** · R16 3/12/1→**19** ·
QF 5/20/2→**32** · SF 8/32/2→**50** · 3º 4/16/1→**25** · Final 12/48/4→**76**.

**Bônus:** Campeão **+40** (só na final) · Artilheiro **+2 × mult de fase por gol**
(mult 1.0/1.5/2.0/3.0/4.0/2.0/5.0) · **Classificado (BPE/BP)** por vaga de KO acertada por fase.

> ⚠️ **Máximo teórico de um palpiteiro perfeito = 1129 pts de jogos** (+ bônus). Use como
> oráculo de sanidade: `72×7+16×9+8×19+4×32+2×50+1×25+1×76 = 1129`.

**Fonte da verdade:** `supabase/migrations/022_additive_scoring.sql`, espelhada em
`src/js/scoring.js` e `scripts/e2e/lib/scoring.js` — **as 3 precisam concordar** (testado por
`scoring-parity.test.js` e `scoring-sql.sql`).

## 6. Modelo de segurança (RLS = única fronteira de confiança real)

- RLS em **todas** as tabelas. Admin tem bypass (`is_admin()`).
- **Palpites travam** às **23h59 BRT da véspera** de cada jogo (`prediction_deadline(match_date)`),
  não no apito. Campeão/artilheiro travam no `settings.deadline_champion_scorer`.
- Palpites alheios só ficam **visíveis após o kickoff** (`match_date <= now()`).
- **Anti-burla:** o `WITH CHECK` de INSERT/UPDATE de `predictions` exige `points_earned IS NULL`
  → **palpite já pontuado é imutável**. Usuário **nunca** escreve `points_earned`.
- Sem auto-promoção a admin/paid; sem IDOR (`compute_predicted_slots`/`qualifier_bonus_for`
  só do próprio); sem DoS via `recompute_*`. Toda escrita em palpite vai pro `prediction_audit`.

## 7. Ciclo de vida & triggers (em `matches`)

Lançar um resultado (`finished=true`) dispara, **em ordem**:
1. `trigger_resolve_slots` → `resolve_match_slots()` — resolve `team_home/away` dos jogos
   seguintes (1A/2A/3X compostos via backtracking → W##/L## em cascata). **Desempate: pts > SG > GF > FIFA rank.**
2. `on_match_finished` — recomputa `points_earned` dos palpites daquele jogo.
3. `trigger_qualifier_bonus` — recomputa o cache BPE/BP.
4. `trg_z_alert_*` — POSTam ao edge (Telegram). **Desligados nos testes** p/ não vazar.

> **Slots:** o seed `01_matches.sql` faz backfill de `slot_home/away` no final (crítico — sem
> isso o mata-mata nunca resolve). Times de KO começam como slots (`W101`, `1A`, `3A/B/C/...`).

## 8. Armadilhas conhecidas (gotchas)

- **Fuso é cúmplice de bugs:** testes de data rodam com `TZ=America/Sao_Paulo` fixa, MAS
  `date-tz-invariance.test.js` varia o fuso em subprocessos. **Não remova esse teste** sem
  substituir a cobertura — senão bugs de fuso (como o de jun/2026) voltam a escapar.
- **Migrations à mão:** prod aplica migrations no **SQL Editor** (sem CLI). Local usa `supabase db reset`.
- **Migrations 050-052 são data-only:** reconciliam elencos. A 052 carrega o elenco canônico
  (1247) como VALUES e passa nos guards mesmo em base vazia → `db reset` recria prod fielmente.
- **Admin isento do gate de avatar** (`auth.js`); usuários comuns sem `avatar_url` vão pra
  `complete-profile.html`.
- **Aba admin "Resultados → lançados"** mostra só os **60 jogos mais recentes** (sem paginação).
- **Players = API-Football** (id = `api_player_id`). NÃO rodar `sync:players` (squads.json é legado).
  EUA = `"USA"` (não "United States", que era o time-fantasma removido pela 052).

## 9. Onde a lógica testável vive

| Lógica | SQL (fonte) | JS (espelho) | Teste |
|---|---|---|---|
| Pontuação | `022_additive_scoring.sql` | `src/js/scoring.js` | `scoring*.test.js`, `scoring-sql.sql` |
| Prazo | `prediction_deadline()` (023) | `src/js/util.js` | `deadline-parity` (unit+e2e) |
| Bracket/slots | `resolve_match_slots()` (005) | `src/js/bracket.js`, `thirds-assign.js` | `bracket.test.js`, `tiebreak.sql` |
| Desempate FIFA | `fifa_rank()` (015) | `src/js/fifa-rank.js` | `tiebreak.sql` B1/B2 |
| Classificado | `qualifier_bonus_*` (021/022) | `src/js/*` | `qualifier.test.js`, `qualifier-bonus.sql` |
| Raio-X | — | `src/js/raiox.js` | `raiox-render.test.js` |
