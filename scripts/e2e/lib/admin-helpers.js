// Helpers Playwright pra UI do admin (lancar resultados).

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

/**
 * Abre admin e vai pra tab Resultados.
 */
export async function openAdminResults(page) {
  await page.goto(`${BASE_URL}/admin.html`);
  // Aguarda tabs renderizarem
  await page.waitForSelector('.admin-tab[data-tab="results"]', { timeout: 15000 });
  // Clica na tab Resultados
  await page.click('.admin-tab[data-tab="results"]');
  // Aguarda result-row aparecer (ou empty state)
  try {
    await page.waitForSelector('.result-row, .empty', { timeout: 15000 });
  } catch {
    // Empty state OK
  }
}

/**
 * Conta matches pendentes (na tela atual).
 */
export async function countPending(page) {
  return await page.$$eval('.result-row:not(.done)', (els) => els.length);
}

/**
 * Lista os match_ids pendentes visiveis.
 */
export async function listPendingMatchIds(page) {
  return await page.$$eval('.result-row:not(.done)', (els) =>
    els.map((el) => parseInt(el.dataset.matchId, 10))
  );
}

/**
 * Lança 1 resultado completo (placar + scorers + pen + save).
 * @param page Playwright Page (já na tela admin/resultados)
 * @param match { id, actual_home, actual_away, pen_winner, scorers, team_home, team_away, stage }
 * @param tracker ErrorTracker
 */
export async function fillSingleResult(page, match, tracker) {
  const { id, actual_home, actual_away, pen_winner, scorers, stage } = match;
  const isKO = stage !== 'group';

  tracker?.setContext({ match_id: id, step: 'lancar_resultado' });

  // 1. Localiza a row
  const rowSel = `.result-row[data-match-id="${id}"]`;
  const rowExists = await page.$(rowSel);
  if (!rowExists) {
    tracker?.track('assertion', `Result row #${id} não encontrada na UI`, { match_id: id });
    return { ok: false };
  }

  // Scroll into view
  await page.$eval(rowSel, (el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));

  // 2. Preenche placar
  await page.fill(`#rh_${id}`, String(actual_home));
  await page.fill(`#ra_${id}`, String(actual_away));

  // 3. Pen winner (se KO e empate)
  if (isKO && actual_home === actual_away && pen_winner) {
    const penBtn = `${rowSel} [data-action="set-pen"][data-side="${pen_winner}"]`;
    try {
      await page.waitForSelector(penBtn, { timeout: 2000 });
      await page.click(penBtn);
    } catch {
      tracker?.track('assertion', `Pen btn não encontrado match #${id}`, { match_id: id, pen_winner });
    }
  }

  // 4. Scorers
  const totalGoals = actual_home + actual_away;
  if (totalGoals > 0 && scorers && scorers.length > 0) {
    // Trigger re-render: a UI mostra a section de scorers quando placar é preenchido
    // Pequena espera pra UI re-renderizar
    await page.waitForTimeout(300);

    // Clica "Carregar jogadores" se aparecer
    const loadBtnSel = `${rowSel} [data-action="load-players"]`;
    const loadBtn = await page.$(loadBtnSel);
    if (loadBtn) {
      await page.click(loadBtnSel);
      // Aguarda players carregar (vai mostrar select)
      try {
        await page.waitForSelector(`${rowSel} #addPlayer_${id}`, { timeout: 5000 });
      } catch {
        tracker?.track('assertion', `Carregar jogadores falhou match #${id}`, { match_id: id });
        // Pode salvar sem scorers? Continua
      }
    }

    // Adiciona cada scorer (loop: select player → qty → add)
    for (const s of scorers) {
      const selectSel = `${rowSel} #addPlayer_${id}`;
      const qtySel = `${rowSel} #addQty_${id}`;
      const addBtnSel = `${rowSel} [data-action="add-scorer"]`;

      const selectExists = await page.$(selectSel);
      if (!selectExists) {
        // Sem players cadastrados pra esse time (skip)
        tracker?.track('info', `Sem select de player pra match #${id}, skipping ${s.full_name}`, { match_id: id });
        break;
      }

      try {
        await page.selectOption(selectSel, String(s.player_id));
      } catch (e) {
        tracker?.track('assertion', `Player ${s.player_id} (${s.full_name}) não no select match #${id}: ${e.message}`, {
          match_id: id, player_id: s.player_id,
        });
        continue;
      }
      await page.fill(qtySel, String(s.goals));
      await page.click(addBtnSel);
      await page.waitForTimeout(300);  // espera a UI re-renderizar com o scorer adicionado
    }
  }

  // 5. Salva
  const saveBtnSel = `${rowSel} [data-action="save-result"]`;
  const saveBtn = await page.$(saveBtnSel);
  if (!saveBtn) {
    tracker?.track('assertion', `Save btn não encontrado match #${id}`, { match_id: id });
    return { ok: false };
  }

  // Confere que está enabled
  const disabled = await page.$eval(saveBtnSel, (el) => el.hasAttribute('disabled'));
  if (disabled) {
    // Tenta entender por quê
    const errText = await page.$eval(`${rowSel}`, (el) => {
      const err = el.querySelector('[style*="color:var(--red)"]');
      return err?.textContent || '(sem mensagem)';
    });
    tracker?.track('assertion', `Save btn disabled match #${id}: ${errText}`, { match_id: id, err: errText });
    return { ok: false, errReason: errText };
  }

  await page.click(saveBtnSel);
  // Aguarda DOM mudar (row.done class)
  try {
    await page.waitForSelector(`${rowSel}.done`, { timeout: 5000 });
  } catch {
    tracker?.track('assertion', `Match #${id} não virou .done apos save`, { match_id: id });
    return { ok: false };
  }

  tracker?.clearContext(['match_id', 'step']);
  return { ok: true };
}
