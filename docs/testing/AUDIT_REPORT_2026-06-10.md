# Auditoria de Véspera — 2026-06-10 (Copa começa amanhã)

**Foco:** features novas pós-auditoria de 06-07 (cards palpite×resultado, gráficos de
ranking) + as 6 invariantes críticas do dia 1. **Veredito:** ✅ todas as suítes verdes ·
**1 bug real encontrado e corrigido** (idempotência do snapshot) · 1 sentinela de prod
obsoleta corrigida (players 1249).

---

## 1. O que esta rodada mudou

A auditoria de 06-07 deixou o núcleo antigo forte, mas **todo o código novo dos últimos
dias estava sem teste**: a classificação dos cards encerrados (dourado/verde/vermelho),
o replay do ranking (`progression.js`, SSOT dos 2 gráficos), os helpers dos gráficos e o
sistema de snapshot de integridade. Essa lógica vivia inline nas páginas (não testável).

### Extração cirúrgica (mesma lógica, agora pura e testada)

| Novo módulo puro | Veio de | Coberto por |
|---|---|---|
| `src/js/card-results.js` | closures de `palpites-grupos.js` / `palpites-mata.js` | `card-results.test.js` (29) |
| `src/js/progression-core.js` | closure de `loadProgression()` | `progression.test.js` (16) |

As páginas mantêm wrappers de 1 linha (estado da página → função pura). `championOf`
(campeão real da final) tinha **2 cópias divergíveis** (progression × palpites-mata);
agora é 1.

### Testes novos (83 asserções unit + 17 vivas)

| Arquivo | Invariante coberta |
|---|---|
| `card-results.test.js` | Dourado no KO exige placar exato + os 2 times; bônus sem palpite = parcial; **paridade card ↔ matchDelta do replay** |
| `progression.test.js` | Fim de série == total do leaderboard; spillover só no último jogo; campeão só na final; usuário sem palpite = linha zerada |
| `chart-utils.test.js` | Posições = permutação 1..N em todo passo; timeline agrupa pelo dia BRT (jogo de 23h59 não "vira" o dia); faixas de fase cobrem o eixo sem buraco |
| `standings-tiebreak.test.js` | Cada nível do desempate de grupo ISOLADO: pts → SG → GF → FIFA (grupo de 4 completo + parciais) |
| `leaderboard-parity.test.js` | ORDER BY do `v_leaderboard` (039) ↔ `sortLeaderboard` (prize.js): mesmos 3 critérios na mesma ordem; só pagantes; void fora |
| `integrity-guards.test.js` | Cron do snapshot (03:10 BRT > trava 23h59); fórmula de prazo idêntica nas cópias; UNIQUEs de players/predictions/player_goals vivos |
| `scripts/e2e/test-integrity-snapshot.js` (`npm run test:integrity`) | Roda snapshot/verify REAIS em sandbox vs DB local: completude (6 248 palpites de 88 jogos travados), formato canônico, idempotência, adulteração detectada na cadeia real |

Catraca de cobertura ampliada: `card-results` 100% · `progression-core` 100% ·
`chart-utils` 71% (resto é render SVG, coberto por e2e).

---

## 2. Bugs encontrados

### B1 — Idempotência do snapshot de integridade NUNCA funcionou (corrigido)
`snapshot.js` incluía `taken_at` DENTRO do conteúdo hasheado → todo run gerava
`content_hash` novo e o guard "Sem mudança" era código morto. Prova: os snapshots #1–#4
do repo são **byte-idênticos exceto pelo relógio** (hash sem `taken_at` igual nos 4).
Violava a invariante "bloquear de novo não duplica".
**Fix:** conteúdo é só DADO (version 2); o instante vive no manifest, no nome do arquivo
e nos timestamps git/Telegram. Cadeia antiga continua íntegra (verify recalcula sobre os
bytes gravados). Provado pelo novo `test:integrity` (17/17).

### B2 — Sentinela de prod obsoleta: `players = 1247` (corrigido)
Os overrides manuais de elenco de 2026-06-09 (autoritativos) levaram prod a 1 249.
Investigação read-only: **zero duplicatas** (api_player_id únicos, nomes únicos);
o delta é Portugal com 27 (4º goleiro Ricardo Velho, camisa 27, nenhum pick nele).
**Fix:** sentinela atualizada p/ 1 249 + `prod-smoke` agora faz checagem ESTRUTURAL de
duplicata (api_player_id único, todo elenco 26–27) em vez de só contar.

---

## 3. Resultado dos gates (rodados nesta véspera, nesta ordem)

| Gate | Resultado |
|---|---|
| `npm test` + `test:coverage` (catraca) | **650/650 ✓** (24 arquivos; 567 → 650) |
| `scoring-sql.sql` (DB, rollback) | **47/47 ✓** |
| `tiebreak.sql` (grupos cheios → R32 populado, FIFA, idempotência) | **12/12 ✓** |
| `qualifier-bonus.sql` | **11/11 ✓** |
| `verify-data.mjs` (recompute independente, todos os usuários) | **✓** 6 248 palpites + 62 totais conferem |
| `npm run test:integrity` (novo) | **17/17 ✓** |
| `npm run test:rls` | **17/17 ✓** |
| `npm run test:render` (pós-refactor das páginas) | **90/90 ✓** |
| `prod-smoke.js` (read-only) | **✓** site no ar, schema em paridade, sem duplicatas |

---

## 4. Risco residual (consciente, não bloqueante)

- **Render dos cards** (HTML em si): a CLASSIFICAÇÃO é testada; o markup é coberto por
  render-adversarial (não vaza lixo) e e2e — não por asserção de conteúdo pixel a pixel.
- **Entrega de alertas Telegram (edge)**: segue não testado localmente (depende de secrets).
- **Clock skew do cliente**: a UI pode divergir segundos do servidor na borda do prazo;
  o RLS é a fronteira real (testado) — pior caso é UX, não integridade.
- **test-rank-chart / 06-ui-assert**: exigem golden-path e MUTAM o banco — não rodados
  nesta véspera de propósito (estado demo-r32 preservado). O núcleo que os alimenta
  (progression/chart-utils) agora tem unit próprio.

## 5. No dia (11/jun)

```bash
npm test && npm run test:coverage          # CI também roda no push
node scripts/e2e/prod-smoke.js             # read-only, ~5s
npm run integrity:verify                   # cadeia pública íntegra
```
