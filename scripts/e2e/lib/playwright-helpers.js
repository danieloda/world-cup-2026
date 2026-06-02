// Helpers Playwright pro E2E.
// Centraliza login, palpitar grupos/mata, set campeao/scorer pela UI.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

export async function login(page, email, password, tracker) {
  tracker?.setContext({ step: 'login' });
  await page.goto(`${BASE_URL}/login.html`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#submitBtn');
  // Aguarda redirect pra inicio (serve faz rewrite — aceita /inicio ou /inicio.html)
  await page.waitForURL(/\/inicio(\.html)?$/, { timeout: 10000 });
  // Aguarda app inicializar (sidebar deve aparecer)
  await page.waitForSelector('.sidebar, .nav, [class*="sidebar"]', { timeout: 10000 });
  tracker?.clearContext(['step']);
}

/**
 * Vai pra palpites-grupos.html e palpita 72 jogos.
 * @param predictions array de { match_id, pred_home, pred_away }
 */
export async function fillGroupPredictions(page, predictions, tracker) {
  tracker?.setContext({ step: 'palpitar_grupos' });
  await page.goto(`${BASE_URL}/palpites-grupos.html`);

  // Aguarda a UI carregar. A aba "palpites" renderiza UM grupo por vez (chips A..L),
  // então precisamos iterar os grupos — não dá pra preencher os 72 numa página só.
  await page.waitForSelector('.chip[data-group], [data-match]', { timeout: 15000 });

  const remaining = new Map(predictions.map(p => [String(p.match_id), p]));

  // Grupos disponíveis (ordem do DOM: A..L). Fallback p/ layout antigo sem chips.
  let groups = await page.$$eval('.chip[data-group]', els => [...new Set(els.map(e => e.dataset.group))]);
  if (groups.length === 0) groups = [null];

  for (const g of groups) {
    if (g !== null) {
      await page.click(`.chip[data-group="${g}"]`);
      await page.waitForTimeout(250); // re-render do grupo selecionado
    }
    const filled = [];
    for (const [mid, p] of [...remaining]) {
      tracker?.setContext({ match_id: Number(mid) });
      const homeSelector = `input[data-match="${mid}"][data-side="home"]`;
      const awaySelector = `input[data-match="${mid}"][data-side="away"]`;
      if (!(await page.$(homeSelector)) || !(await page.$(awaySelector))) continue;

      await page.fill(homeSelector, String(p.pred_home));
      await page.fill(awaySelector, String(p.pred_away));
      await page.evaluate((sel) => document.querySelector(sel)?.blur(), awaySelector);
      filled.push(mid);
      remaining.delete(mid);
    }

    // CRÍTICO: espera o debounce (700ms) + upsert concluir ANTES de trocar de grupo.
    // doSave() lê o valor da row do DOM; se o re-render remover a row antes do save,
    // o palpite é perdido silenciosamente.
    if (filled.length) {
      try {
        await page.waitForFunction(
          (ids) => ids.every(id =>
            document.querySelector(`.match[data-match-id="${id}"]`)?.classList.contains('saved')),
          filled, { timeout: 8000 }
        );
      } catch {
        await page.waitForTimeout(1500);
      }
    }
  }

  // Sobrou alguém = realmente não renderizou em nenhum grupo.
  for (const [mid] of remaining) {
    tracker?.track('assertion', `Inputs grupos não encontrados para match ${mid}`, { match_id: Number(mid) });
  }
  tracker?.clearContext(['step', 'match_id']);
}

/**
 * Vai pra palpites-mata.html e palpita 32 jogos KO.
 * @param predictions array de { match_id, pred_home, pred_away, pred_pen_winner }
 *
 * IMPORTANTE: O bracket re-renderiza o card quando estado de empate muda
 * (palpites-mata.js:rerenderMatchAndKeepFocus). Por isso usamos selectors
 * a cada operação ao inves de cachear element handles.
 */
export async function fillKnockoutPredictions(page, predictions, tracker) {
  tracker?.setContext({ step: 'palpitar_mata' });
  await page.goto(`${BASE_URL}/palpites-mata.html`);
  await page.waitForSelector('.bracket-match', { timeout: 15000 });

  for (const p of predictions) {
    tracker?.setContext({ match_id: p.match_id });
    const homeSelector = `input[data-match="${p.match_id}"][data-side="home"]`;
    const awaySelector = `input[data-match="${p.match_id}"][data-side="away"]`;

    // Confere que existem antes de fill
    const homeExists = await page.$(homeSelector);
    const awayExists = await page.$(awaySelector);
    if (!homeExists || !awayExists) {
      tracker?.track('assertion', `Inputs KO não encontrados para match ${p.match_id}`, { match_id: p.match_id });
      continue;
    }

    // page.fill re-localiza o elemento internamente, tolera DOM rerender
    await page.fill(homeSelector, String(p.pred_home));
    await page.fill(awaySelector, String(p.pred_away));
    // Blur via JS no document (mais robusto que awayInput.evaluate)
    await page.evaluate((sel) => document.querySelector(sel)?.blur(), awaySelector);

    // Se empate, clica no pen winner (espera rerender que cria o botão)
    if (p.pred_home === p.pred_away && p.pred_pen_winner) {
      const penSelector = `.bracket-match[data-match-id="${p.match_id}"] [data-action="set-pen"][data-side="${p.pred_pen_winner}"]`;
      try {
        await page.waitForSelector(penSelector, { timeout: 2000 });
        await page.click(penSelector);
      } catch {
        tracker?.track('assertion', `Pen winner btn não encontrado para match ${p.match_id}`, { match_id: p.match_id, side: p.pred_pen_winner });
      }
    }
  }

  // Aguarda debounce save (700ms no app + margem)
  await page.waitForTimeout(2000);
  tracker?.clearContext(['step', 'match_id']);
}

/**
 * Define campeao e artilheiro via campeao-artilheiro.html
 * @param champTeam team name ou null pra pular
 * @param scorer { id, team } do player ou null pra pular
 */
export async function fillChampionScorer(page, champTeam, scorer, tracker) {
  if (!champTeam && !scorer) {
    return;
  }

  tracker?.setContext({ step: 'cs' });
  await page.goto(`${BASE_URL}/campeao-artilheiro.html`);
  await page.waitForSelector('.cs-card', { timeout: 15000 });

  // Champion pick
  if (champTeam) {
    tracker?.setContext({ sub: 'champion' });
    const teamRow = await page.$(`[data-action="pick-team"][data-team="${champTeam}"]`);
    if (teamRow) {
      await teamRow.click();
      await page.waitForTimeout(800);
    } else {
      tracker?.track('assertion', `Champion team button não encontrado: ${champTeam}`, { team: champTeam });
    }
  }

  // Scorer pick (recebe { id, team } pra evitar fetch extra)
  if (scorer && scorer.id && scorer.team) {
    tracker?.setContext({ sub: 'scorer' });
    // Clica no país do player (Step 1 da seleção)
    const countryBtn = await page.$(`[data-action="select-country"][data-country="${scorer.team}"]`);
    if (countryBtn) {
      await countryBtn.click();
      // Aguarda lista de players carregar (assincrono — espera o player aparecer)
      try {
        await page.waitForSelector(`[data-action="pick-player"][data-player="${scorer.id}"]`, { timeout: 5000 });
      } catch {
        tracker?.track('assertion', `Player ${scorer.id} não apareceu na lista`, { player_id: scorer.id, team: scorer.team });
        tracker?.clearContext(['step', 'sub']);
        return;
      }
      // Clica no player
      const playerRow = await page.$(`[data-action="pick-player"][data-player="${scorer.id}"]`);
      if (playerRow) {
        await playerRow.click();
        await page.waitForTimeout(800);
      } else {
        tracker?.track('assertion', `Player row não encontrada: ${scorer.id}`, { player_id: scorer.id, team: scorer.team });
      }
    } else {
      tracker?.track('assertion', `Country select não encontrado: ${scorer.team}`, { team: scorer.team });
    }
  }

  tracker?.clearContext(['step', 'sub']);
}
