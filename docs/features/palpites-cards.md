# Cards unificados de Palpite — Grupos & Mata-mata (runbook de contexto)

> Referência rápida pra **debugar durante a Copa**. O que mudou, de onde vem cada
> número, e o que checar quando algo parecer errado.
> Implementado em jun/2026 (commit `8dfb6d3`). Arquivos: `src/js/pages/palpites-grupos.js`,
> `src/js/pages/palpites-mata.js`, `src/js/util.js`, `src/css/app.css`.

---

## 1. O que mudou (resumo)

As duas páginas (`palpites-grupos.html`, `palpites-mata.html`) **deixaram de ter abas**
"Palpites" / "Resultados Oficiais". Agora é **um fluxo só**: cada jogo é um card que
**se adapta ao estado**:

| Estado do jogo | Card mostra |
|---|---|
| **Aberto** (`finished=false`) | inputs editáveis de placar |
| **Encerrado** (`finished=true`) | seu palpite × resultado oficial + pontuação |

Nada de scoring foi reimplementado no cliente — os cards **só leem e exibem** o que o
servidor já calcula. A fonte da verdade do total continua sendo o `v_leaderboard`.

---

## 2. De onde vem cada número (CRÍTICO p/ debug de pontos)

O total de um jogo no card = soma de 4 componentes, **cada um de uma fonte diferente**:

| Componente | Fonte (tabela/coluna) | Função no card |
|---|---|---|
| **Placar** (lado/resultado/saldo/exato) | `predictions.points_earned` | `scoreBreakdown()` (de `scoring.js`) |
| **Classificado** (BPE/BP) | `user_qualifier_points.breakdown.items[]` (cache SQL) | `matchQualPts(m)` |
| **Artilheiro** | `player_goals` × `top_scorer_picks` | `matchScorerPts(m)` = `scorerBonus(gols, stage)` |
| **Campeão** (só na final) | `champion_picks` × vencedor da final | `matchChampionPts(m)` = `championBonus(true)` (+40) |

> ⚠️ **`points_earned` é SÓ o placar.** Classificado, artilheiro e campeão são
> **separados** e somados no cliente para o total do card. Isso é **idêntico** ao
> `matchDelta()` em `src/js/pages/ranking.js` (a reconstrução do leaderboard). Se o
> card e o ranking divergirem, a lógica está nesses dois lugares — mantenha em sincronia.

**Multiplicadores** (`stageMultiplier` em `scoring.js`): grupos ×1 · r32 ×1.5 · oitavas ×2 ·
quartas ×3 · semis ×4 · 3º/final ×... (ver `scoring.js`). Artilheiro = `gols × 2 × mult`.

**Validação feita:** reconstrução manual bateu exato com `v_leaderboard` em dois estados
(r32 = 200 pts; torneio completo = 464 pts).

---

## 3. Mata-mata — anatomia do card (`palpites-mata.js`)

- `renderCard(m)` → despacha: `renderFinishedCard(m)` ou `renderOpenCard(m)`.
- **Encerrado** (`renderFinishedCard`): duas faixas (SEU PALPITE × RESULTADO OFICIAL).
  - Linhas via `renderFinRow(m, lens, side)` com **classes de área do grid** (`km-area-predhome`,
    `km-area-offhome`, etc.). O CSS `.km-lanes` usa `grid-template-areas` → home alinha com
    home e away com away **mesmo quando só o lado oficial tem o selo "classificado"**
    (foi o bug do "desnivelado"). Desktop largo (`.bracket-date-list`) = 2 colunas; mobile = empilhado.
  - `resultClass`: `exact` (placar exato) · `partial` (algum ponto, incl. só bônus) ·
    `miss` (zero) · `no-pred` (sem palpite **e** sem bônus).
  - `totalPts = pts + qualPts + scorerPts + champPts`. Chips em `renderBmBreak()`.
- **Aberto** (`renderOpenCard` / `renderOpenTeamRow`):
  - Mostra o **time real** se a vaga já saiu (`team_home/away` resolvido); senão o time da
    **sua simulação** (`predSlotResolution`, lente só-palpites).
  - Quando o real diverge do previsto: chip **"na sua simulação: 🏳 X"** (`.bm-diverge`).
- **Resolução de vagas** (slots `W73`/`L101`/`1A`/`3A/B/...`): vem de `bracket.js` (puro, 354 testes).
  - `slotResolution` = real-first (resultado real ou, na falta, palpite).
  - `predSlotResolution` = pred-only (só seus palpites) → usado nos cards abertos e na faixa "seu palpite".
- **Vaga como sublinha**: `slotLineLabel(slot)` → "2º Grupo A", "Venc. M74", "3º (Primeiro Colocado)".
  - As 8 vagas de melhor-3º são numeradas por `thirdSlotIndex` (ordem dos jogos r32) →
    "3º (Primeiro Colocado)" … "3º (Oitavo Colocado)" (`ORDINAIS`).

---

## 4. Grupos — anatomia do card (`palpites-grupos.js`)

- Fluxo único: `renderBody` → `renderMatchesList()` rende **todos** os jogos do filtro;
  cada um vira `renderResultRow(m)` (encerrado) ou `renderPalpiteRow(m)` (aberto).
- **Encerrado** (`renderResultRow` + `grTeamRow`): colunas alinhadas **VOCÊ × OFICIAL**
  (seu palpite com o mesmo destaque do placar real). Total = `points_earned + matchScorerPts`.
  Grupos **não têm** classificado nem campeão (só placar + artilheiro).
- **Classificação / Melhores 3ºs**: toggle **Projeção ⇄ Oficial** (`standMode` = `'sim'`/`'real'`),
  no lugar das antigas abas. `renderGroupTableSection()` + `renderThirdsPop(standMode)`.
- Contadores `computeCounts()` agora abrangem **todos** os jogos (`allByGroup`/`allByDate`),
  não só abertos/encerrados separados.

---

## 5. Calendário — cor por estado (`util.js`)

`dayPredictionStatus(done, total, deadline, played)` → classe `st-*`:

| status | quando | cor |
|---|---|---|
| `past` | dia **já jogado** (`played`) ou prazo passou, e tudo palpitado | cinza-azulado ("Encerrado") |
| `done` | tudo palpitado e **ainda por jogar** | verde ("Palpitado") |
| `urgent`/`soon`/`pending` | pendente, por proximidade do bloqueio | vermelho/amarelo/cinza |
| `locked` | prazo passou sem palpitar tudo | cinza apagado ("Não palpitado") |

> O `played` vem do `buildDateMeta` de cada página (= todos os jogos do dia `finished`).
> **Por isso datas já jogadas não ficam mais verdes.**

---

## 6. Playbook de DEBUG (durante a Copa)

**"Os pontos do card não batem com o ranking"**
1. `points_earned` é só placar — confira se está somando classificado+artilheiro+campeão.
2. Compare com `matchDelta()` em `ranking.js` (mesma fórmula). Se lá bate e no card não,
   o bug está no card; se nos dois não bate, é o servidor (gatilho/cache).
3. Classificado vem do **cache** `user_qualifier_points` (gatilho SQL). Se o cache estiver
   defasado, o card mostra defasado — recalcular é no servidor, não no cliente.

**"Card encerrado não aparece / fica como aberto"**
- O card usa a flag `matches.finished`. Se o admin lançou resultado mas `finished` não virou
  `true`, o card continua aberto. Checar a linha em `matches`.

**"Faixas desalinhadas no mata-mata"** → CSS `.km-lanes` (grid-areas) em `app.css`.

**"Vaga errada / 'na sua simulação' some"** → resolução em `bracket.js` +
`predSlotResolution`/`slotResolution` no `loadData`. Vaga só resolve se a cadeia de
palpites/resultados a montante estiver completa (sem palpite na origem → mostra "—").

**"Calendário com dia errado de cor"** → `dayPredictionStatus` (util.js) + `played` no
`buildDateMeta` da página.

**"Histórico vazio / 'A Copa ainda não começou'"** → **não é bug**: `historico.js` só revela
jogos com `match_date <= now()`. Antes do jogo acontecer, mostra a prévia. (Página não foi
alterada nesta feature.)

**"Site fazendo requests sem parar / tudo em branco"** → quase sempre **backend fora**
(Docker/Supabase local caído). Checar `docker ps` + endpoint de auth. O cliente Supabase
retenta token sem parar quando o backend não responde.

---

## 7. Reproduzir estados localmente (scripts em `scripts/e2e/`)

```bash
set -a; source .env.e2e.local; set +a

# conta de teste com todos os palpites + campeão + artilheiro
node scripts/e2e/seed-my-account.js          # eu@local.test / Palpite2026!

# finalizar parte do torneio (grupos+r32) e pontuar
node scripts/e2e/gen-playout-r32.js          # gera playout-r32.sql
docker exec -i supabase_db_world-cup-2026 psql -U postgres -d postgres < scripts/e2e/playout-r32.sql
node scripts/e2e/gen-playout-r32.js --max=104 --out=playout-full.sql   # torneio inteiro

# alternar calendário: "Copa em andamento" (encerrados no passado) ⇄ canônico
node scripts/e2e/preset-inprogress.js --capture   # 1x: salva datas canônicas
node scripts/e2e/preset-inprogress.js --on        # encerrados→passado, abertos→futuro
node scripts/e2e/preset-inprogress.js --off        # volta às datas reais (pré-Copa)
```

> Voltar o front pra PROD: `npm run build:config` (lê `.env`). O `config.js` local é gitignored.

---

## 8. Riscos residuais conhecidos

- O card **só exibe** o que o servidor calcula. Se os gatilhos de scoring/classificado/slots
  (pré-existentes, em prod) errarem, o card mostra fielmente o erro. Validar 1 card vs ranking
  **no primeiro resultado real** da Copa cobre isso.
- Demo local marca jogos `finished` com **datas de 2026 (futuras)** → páginas date-gated
  (histórico/RLS) agem como pré-Copa. Use `preset-inprogress.js --on` p/ um demo coerente.
- Campeão (+40) e o `matchDelta` do ranking precisam ficar **em sincronia** com os cards se
  a regra de pontuação mudar.
