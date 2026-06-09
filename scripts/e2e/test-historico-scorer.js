#!/usr/bin/env node
/**
 * E2E: "Palpites da galera" (historico.html) — pontos por palpite + BÔNUS DE ARTILHEIRO.
 *
 * Cobre a feature nova (commit "bônus de artilheiro por jogo + popovers"):
 *   - o chip ⚽+N aparece SÓ na linha de quem (a) palpitou aquele jogo E
 *     (b) cujo artilheiro escolhido marcou ali; o valor == scorerBonus(gols, fase).
 *   - os pontos do palpite (.pts) batem com predictions.points_earned.
 *   - popover do palpite (betTip) soma == pts; popover do artilheiro (scorerTip)
 *     mostra gols × 2 × peso da fase (sem linha "Peso" quando o multiplicador é 1).
 *
 * Read-only: não muta o DB. Loga como um test user pago e compara o DOM com o
 * oráculo derivado do próprio banco (admin client) — nada hardcoded além dos
 * jogos âncora usados pra navegar (final ×5, quartas ×3, grupo ×1).
 *
 * Pré-req: pipeline já rodado (104 jogos finalizados, test users pagos com picks).
 *   source .env.e2e.local && node scripts/e2e/test-historico-scorer.js
 */
import { chromium } from 'playwright';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { makeAdminClient } from './lib/admin-client.js';
import { scorerBonus, stageMultiplier } from '../../src/js/scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const C = { r: '\x1b[31m', g: '\x1b[32m', b: '\x1b[34m', d: '\x1b[2m', x: '\x1b[0m', bold: '\x1b[1m' };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`   ${pass ? C.g + '✓' : C.r + '✗'} ${name}${detail ? C.d + ' — ' + detail : ''}${C.x}`);
};
const ms = (arr) => [...arr].sort().join('|'); // multiset key (ordem-independente)

const admin = makeAdminClient();

// ---- oráculo derivado do DB: o que CADA jogo deve mostrar ----
// Retorna { rows: [{full_name, pts, chip|null}], chips: [valores], stage }
async function expectedForMatch(matchId) {
  const [{ data: m }, { data: preds }, { data: picks }, { data: goals }] = await Promise.all([
    admin.from('matches').select('stage').eq('id', matchId).single(),
    admin.from('predictions').select('user_id, points_earned, profiles(full_name, paid)').eq('match_id', matchId),
    admin.from('top_scorer_picks').select('user_id, player_id'),
    admin.from('player_goals').select('player_id, goals').eq('match_id', matchId),
  ]);
  const pickBy = new Map((picks ?? []).map(p => [p.user_id, p.player_id]));
  const goalBy = new Map((goals ?? []).map(g => [g.player_id, g.goals]));
  const rows = (preds ?? [])
    .filter(p => p.profiles?.paid)
    .map(p => {
      const pid = pickBy.get(p.user_id);
      const gls = pid != null ? (goalBy.get(pid) ?? 0) : 0;
      const chip = gls > 0 ? scorerBonus(gls, m.stage) : null;
      const pts = p.points_earned ?? 0;
      return { full_name: p.profiles.full_name, ptsTxt: pts > 0 ? `+${pts}` : '0', chip };
    });
  return { stage: m.stage, rows, chips: rows.filter(r => r.chip != null).map(r => `+${r.chip}`) };
}

// ---- leitura do DOM dentro de um card específico ----
async function readCard(locator) {
  return locator.evaluate(card => [...card.querySelectorAll('.hb-row')].map(r => ({
    name: r.querySelector('.nm')?.textContent?.trim() || '',
    ptsTxt: r.querySelector('.pts')?.textContent?.trim() || '',
    chip: r.querySelector('.hb-scorer')?.textContent?.trim() || null,
  })));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const shotsDir = join(__dirname, 'screenshots'); mkdirSync(shotsDir, { recursive: true });

console.log(`${C.b}${C.bold}⚽ Palpites da galera: pontos + bônus de artilheiro${C.x}`);

// login como um test user PAGO que escolheu o artilheiro real (vê "Você" + chips)
const ME = { email: 'test-perfect-2026@testuser.com', password: 'TestUser2026!', name: 'Perfeito (Player 1)' };
await page.goto(`${BASE}/login.html`);
await page.fill('#email', ME.email);
await page.fill('#password', ME.password);
await page.click('#submitBtn');
await page.waitForURL(/\/inicio(\.html)?$/, { timeout: 15000 });

// jogos âncora (descobre id/dia da Final, das Quartas com gol do artilheiro e do grupo)
const { data: anchorMatches } = await admin.from('matches')
  .select('id, stage, group_name, team_home, team_away, match_date, actual_home, actual_away')
  .in('id', [104, 98, 47]);
const byId = new Map(anchorMatches.map(m => [m.id, m]));
const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

await page.goto(`${BASE}/historico.html`);
await page.waitForSelector('.history-card', { timeout: 15000 });

// ============================================================
// A) Card da FINAL (peso ×5) — chips +30, pontos, caso negativo, "Você"
// ============================================================
console.log(`\n${C.b}A) Final (Cabo Verde × Egito) — bônus ×5${C.x}`);
const finalDay = dayKey(byId.get(104).match_date);
await page.click('[data-stage="ko"]');
await page.waitForSelector(`.cal-day[data-date="${finalDay}"]`, { timeout: 8000 });
await page.click(`.cal-day[data-date="${finalDay}"]`);
await page.waitForSelector('.history-card.final', { timeout: 8000 });

const expFinal = await expectedForMatch(104);
const finalCard = page.locator('.history-card.final').first();
const domFinal = await readCard(finalCard);

check('final: 1 linha por palpite de pago == DB',
  domFinal.length === expFinal.rows.length, `dom=${domFinal.length} db=${expFinal.rows.length}`);

const domChipsFinal = domFinal.filter(r => r.chip).map(r => r.chip);
check('final: chips de artilheiro (conjunto) == esperado',
  ms(domChipsFinal) === ms(expFinal.chips),
  `dom=[${domChipsFinal.join(',')}] exp=[${expFinal.chips.join(',')}]`);
check('final: todo chip da final vale +30 (3 gols × 2 × 5)',
  domChipsFinal.length > 0 && domChipsFinal.every(c => c === '+30'),
  `chips=[${domChipsFinal.join(',')}]`);

const domPtsFinal = domFinal.map(r => r.ptsTxt);
const expPtsFinal = expFinal.rows.map(r => r.ptsTxt);
check('final: pontos por linha (conjunto) == predictions.points_earned',
  ms(domPtsFinal) === ms(expPtsFinal), `dom=${ms(domPtsFinal)} exp=${ms(expPtsFinal)}`);

const meRow = domFinal.find(r => r.name === 'Você');
check('final: linha "Você" mostra +76 e chip +30',
  !!meRow && meRow.ptsTxt === '+76' && meRow.chip === '+30',
  meRow ? `pts=${meRow.ptsTxt} chip=${meRow.chip}` : 'sem linha Você');

// caso NEGATIVO: cravou a final mas artilheiro não marcou → SEM chip
const negName = 'Quase-Perfeito B (Player 3)';
const negRow = domFinal.find(r => r.name === negName);
const negExp = expFinal.rows.find(r => r.full_name === negName);
check('final: quem cravou mas escolheu artilheiro sem gol NÃO tem chip',
  !!negRow && negRow.chip === null && negExp && negExp.chip === null,
  negRow ? `pts=${negRow.ptsTxt} chip=${negRow.chip}` : 'sem linha P3');

await finalCard.scrollIntoViewIfNeeded();
await finalCard.screenshot({ path: join(shotsDir, 'hist-scorer-final.png') }).catch(() => {});

// popover do artilheiro (scorerTip): mostra gols × 2 × peso ×5 e total +30
const meScorerChip = finalCard.locator('.hb-row', { hasText: 'Você' }).locator('.hb-scorer').first();
await meScorerChip.hover();
await page.waitForSelector('.hist-tip.show', { timeout: 4000 }).catch(() => {});
const scorerTip = await page.locator('.hist-tip.show').innerText().catch(() => '');
check('final: popover do artilheiro soma +30 e cita o peso ×5',
  /\+30/.test(scorerTip) && /×\s*5/.test(scorerTip), `tip="${scorerTip.replace(/\n/g, ' ⏎ ')}"`);
await page.mouse.move(5, 5); // dispersa o hover do artilheiro

// popover do palpite (betTip): total bate com os pts da linha "Você" (+76 exato).
// O .hist-tip some no 'scroll' (comportamento de produto) e o .hover() do Playwright
// dispara um scroll de actionability — então rolamos e deixamos ASSENTAR antes do hover,
// senão o tip recém-aberto é escondido pelo scroll e a leitura vem vazia.
const mePtsChip = finalCard.locator('.hb-row', { hasText: 'Você' }).locator('.pts').first();
await mePtsChip.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await mePtsChip.hover();
await page.waitForFunction(
  () => { const t = document.querySelector('.hist-tip.show'); return !!t && /\+76/.test(t.textContent || ''); },
  { timeout: 4000 }).catch(() => {});
const betTip = await page.locator('.hist-tip.show').innerText().catch(() => '');
check('final: popover do palpite "Você" mostra total +76',
  /\+76/.test(betTip), `tip="${betTip.replace(/\n/g, ' ⏎ ')}"`);
await page.mouse.move(5, 5);

// ============================================================
// B) Card de GRUPO (peso ×1) — chips +2, popover SEM linha de peso
// ============================================================
console.log(`\n${C.b}B) Grupo (Cabo Verde × Arábia Saudita) — bônus ×1${C.x}`);
const gM = byId.get(47);
const groupDay = dayKey(gM.match_date);
await page.click('[data-stage="group"]');
await page.waitForSelector(`.cal-day[data-date="${groupDay}"]`, { timeout: 8000 });
await page.click(`.cal-day[data-date="${groupDay}"]`);
await page.waitForSelector('.history-card', { timeout: 8000 });

// acha o card pelos times (cards não têm match_id no DOM)
const gIdx = await page.$$eval('.history-card', (cards, [a, b]) => {
  for (let i = 0; i < cards.length; i++) {
    const t = cards[i].querySelector('.history-fixture')?.textContent || '';
    if (t.includes(a) && t.includes(b)) return i;
  }
  return -1;
}, ['Cabo Verde', 'Arábia Saudita']);
check('grupo: card Cabo Verde × Arábia Saudita encontrado', gIdx >= 0, `idx=${gIdx}`);

if (gIdx >= 0) {
  const gCard = page.locator('.history-card').nth(gIdx);
  const expG = await expectedForMatch(47);
  const domG = await readCard(gCard);
  const domChipsG = domG.filter(r => r.chip).map(r => r.chip);
  check('grupo: chips (conjunto) == esperado e valem +2 (1 gol × 2 × 1)',
    ms(domChipsG) === ms(expG.chips) && domChipsG.length > 0 && domChipsG.every(c => c === '+2'),
    `dom=[${domChipsG.join(',')}] exp=[${expG.chips.join(',')}]`);

  // popover do artilheiro no grupo: multiplicador 1 → NÃO deve citar "Peso"
  check('scoring: stageMultiplier(group) == 1 (sanity p/ ausência de linha de peso)',
    stageMultiplier('group') === 1, `mult=${stageMultiplier('group')}`);
  const gScorerChip = gCard.locator('.hb-scorer').first();
  if (await gScorerChip.count()) {
    // Lê o CONTEÚDO do popover direto do <template class="tip-src"> (irmão do chip,
    // a fonte que o tooltip.js renderiza). Determinístico — sem depender de hover,
    // que é flaky em headless (o auto-scroll dispara scroll→hide). Mesmo invariante:
    // grupo (mult ×1) soma +2 e NÃO tem linha de "Peso". O hover em si já é coberto
    // pelo popover da FINAL acima.
    const gTip = await gCard.evaluate((card) => {
      const chip = card.querySelector('.hb-scorer[data-tip]');
      // o <template class="tip-src"> do artilheiro é o IRMÃO IMEDIATO do chip
      // (o .hb-row tem outro tip-src, do palpite, antes — não confundir).
      const tpl = chip?.nextElementSibling;
      return (tpl && tpl.classList.contains('tip-src')) ? tpl.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    });
    check('grupo: popover do artilheiro soma +2 e NÃO mostra linha de "Peso"',
      /\+2/.test(gTip) && !/Peso/.test(gTip), `tip="${gTip.slice(0, 70)}"`);
  }
  await gCard.screenshot({ path: join(shotsDir, 'hist-scorer-group.png') }).catch(() => {});
}

await browser.close();

// ===== resumo =====
const failed = results.filter(r => !r.pass);
console.log(`\n${C.b}${C.bold}Resumo: ${results.length - failed.length}/${results.length} OK${C.x}`);
if (failed.length) {
  console.log(`${C.r}Falhas: ${failed.map(f => f.name).join('; ')}${C.x}`);
  process.exit(1);
}
console.log(`${C.g}${C.bold}🎉 Pontos + bônus de artilheiro batem com o DB.${C.x}`);
process.exit(0);
