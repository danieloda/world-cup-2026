// standings-view.js — renderização compartilhada de classificação de grupos
// e tabela dos melhores 3ºs colocados.
//
// Usado por palpites-grupos.js nas duas abas, sempre por grupo:
//   - aba "Palpites"  → classificação PROJETADA + 3ºs no popover (modo 'sim')
//   - aba "Resultados"→ classificação OFICIAL  + 3ºs no popover (modo 'real')
// (As antigas grupos.html / terceiros.html foram fundidas aqui e viraram redirects.)
//
// Todas as funções são puras: recebem (groupMatches, mode, predsByMatch) e
// devolvem HTML. Nenhuma depende de estado de módulo — assim as telas
// compartilham exatamente a mesma lógica sem risco de drift.

import { flag, escapeHtml, teamPt, computeStandings } from './util.js';
import { fifaRank } from './fifa-rank.js';

export const GROUPS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
export const ADVANCE_COUNT = 8; // 8 melhores 3ºs avançam aos 32-avos

// ============================================================
// Classificação — card de um grupo
// ============================================================
export function renderGroupCard(g, groupMatches, mode, predsByMatch) {
  const matches = groupMatches.filter(m => m.group_name === g);
  const finishedCount = matches.filter(m => m.finished).length;
  const predictedCount = matches.filter(m => predsByMatch.has(m.id)).length;

  const standings = computeStandings(matches, mode, predsByMatch);

  const statusText = mode === 'real'
    ? `${finishedCount}/6 jogos`
    : `${predictedCount}/6 palpitados`;

  return `
    <div class="group-card">
      <div class="group-head">
        <div class="group-name">Grupo ${g}</div>
        <div class="group-stage-info">${statusText}</div>
      </div>
      <div class="hscroll"><div class="hscroll-in">
      <table class="group-table">
        <thead>
          <tr>
            <th class="left">Time</th>
            <th>J</th><th>V</th><th>E</th><th>D</th>
            <th>SG</th><th>PTS</th>
          </tr>
        </thead>
        <tbody>
          ${renderStandingsRows(standings, matches)}
        </tbody>
      </table>
      </div></div>
    </div>
  `;
}

// ------------------------------------------------------------
// Linha/tabela canônica — markup COMPARTILHADO por todas as tabelas de
// classificação do site (grupos, e a seção Eliminatórias do Raio-X). Manter
// um só renderizador garante que todas fiquem visualmente idênticas.
// `r` normalizado: { pos, team, j, v, e, d, sg, pts, cls?, hl? }
//   cls: 'qualified' | 'third' | 'out'  → cor base por status (verde/bronze/—)
//   hl:  'home' | 'away' | 'focus'      → destaque do confronto (só no Raio-X)
// ------------------------------------------------------------
export function renderStandingRow(r) {
  const sgStr = r.sg > 0 ? `+${r.sg}` : `${r.sg}`;
  const cls = [r.cls, r.hl && `hl-${r.hl}`].filter(Boolean).join(' ');
  return `
    <tr class="${cls}">
      <td class="team-cell">
        <span class="position">${r.pos}</span>
        <span class="flag">${flag(r.team)}</span>
        <span class="team-name" data-team="${escapeHtml(r.team)}">${escapeHtml(teamPt(r.team))}</span>
      </td>
      <td>${r.j}</td><td>${r.v}</td><td>${r.e}</td><td>${r.d}</td>
      <td>${sgStr}</td><td class="pts">${r.pts}</td>
    </tr>`;
}

export function renderStandingTable(rows) {
  return `
    <div class="hscroll"><div class="hscroll-in">
    <table class="group-table">
      <thead><tr>
        <th class="left">Time</th><th>J</th><th>V</th><th>E</th><th>D</th><th>SG</th><th>PTS</th>
      </tr></thead>
      <tbody>${rows.map(renderStandingRow).join('')}</tbody>
    </table>
    </div></div>`;
}

function renderStandingsRows(standings, matches) {
  // Se nenhum jogo finalizado/palpitado, mostra times sem stats
  if (standings.length === 0) {
    const teams = new Set();
    for (const m of matches) {
      teams.add(m.team_home);
      teams.add(m.team_away);
    }
    return [...teams].map((team, i) =>
      renderStandingRow({ pos: i + 1, team, j: 0, v: 0, e: 0, d: 0, sg: 0, pts: 0, cls: 'out' })).join('');
  }

  return standings.map((s, idx) => {
    const pos = idx + 1;
    const cls = pos <= 2 ? 'qualified' : (pos === 3 ? 'third' : 'out');
    return renderStandingRow({ pos, team: s.team, j: s.j, v: s.v, e: s.e, d: s.d, sg: s.sg, pts: s.pts, cls });
  }).join('');
}

// ============================================================
// Melhores 3ºs
// ============================================================
/**
 * Retorna a lista dos 3ºs colocados de todos os grupos, ordenados.
 * Cada item: { team, group, j, v, e, d, gp, gc, sg, pts, complete }
 *   complete: true se o grupo está completo no modo atual
 */
export function computeThirds(groupMatches, mode, predsByMatch) {
  const thirds = [];
  for (const g of GROUPS) {
    const matches = groupMatches.filter(m => m.group_name === g);
    const standings = computeStandings(matches, mode, predsByMatch);
    const third = standings[2];

    let complete;
    if (mode === 'real') {
      complete = matches.every(m => m.finished);
    } else {
      complete = matches.every(m => predsByMatch.has(m.id));
    }

    if (third && complete) {
      thirds.push({ ...third, group: g, complete: true });
    } else if (third) {
      thirds.push({ ...third, group: g, complete: false });
    } else {
      thirds.push({ team: null, group: g, complete: false });
    }
  }

  // Ordenar: completos primeiro, depois por PTS → SG → GP → FIFA rank (oficial)
  return thirds.sort((x, y) => {
    if (x.complete !== y.complete) return x.complete ? -1 : 1;
    if (!x.complete && !y.complete) return 0;
    return (y.pts ?? 0) - (x.pts ?? 0)
        || (y.sg ?? 0) - (x.sg ?? 0)
        || (y.gp ?? 0) - (x.gp ?? 0)
        || fifaRank(x.team) - fifaRank(y.team);
  });
}

export function countThirdsComplete(thirds) {
  return thirds.filter(t => t.complete).length;
}

export function renderThirdsTable(thirds) {
  return `
    <div class="hscroll"><div class="hscroll-in">
    <table class="thirds-table">
      <thead>
        <tr>
          <th class="left">#</th>
          <th class="left">Seleção</th>
          <th class="left">Grupo</th>
          <th>J</th><th>V</th><th>E</th><th>D</th>
          <th>GP</th><th>GC</th><th>SG</th><th>PTS</th>
        </tr>
      </thead>
      <tbody>
        ${renderThirdsRows(thirds)}
      </tbody>
    </table>
    </div></div>
  `;
}

function renderThirdsRows(thirds) {
  const rows = [];
  let dividerInserted = false;

  thirds.forEach((t, idx) => {
    const rank = idx + 1;
    const isOut = rank > ADVANCE_COUNT;

    if (isOut && !dividerInserted) {
      rows.push(`
        <tr class="divider">
          <td colspan="11">— linha de corte · ${ADVANCE_COUNT} avançam · 4 eliminados —</td>
        </tr>
      `);
      dividerInserted = true;
    }

    rows.push(renderThirdsRow(t, rank, isOut));
  });

  return rows.join('');
}

function renderThirdsRow(t, rank, isOut) {
  const rowClass = t.complete ? (isOut ? 'out' : 'adv') : 'out';

  if (!t.team) {
    return `
      <tr class="out">
        <td class="left"><span class="rank">${rank}</span></td>
        <td class="left" style="color:var(--text-mute);">aguardando…</td>
        <td class="left"><span class="group-badge">${t.group}</span></td>
        <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
      </tr>
    `;
  }

  const sgStr = t.sg > 0 ? `+${t.sg}` : t.sg;
  return `
    <tr class="${rowClass}">
      <td class="left"><span class="rank">${rank}</span></td>
      <td class="left">
        <div class="team-cell">
          <span class="flag">${flag(t.team)}</span>
          <span class="team-name" data-team="${escapeHtml(t.team)}">${escapeHtml(teamPt(t.team))}</span>
        </div>
      </td>
      <td class="left"><span class="group-badge">${t.group}</span></td>
      <td>${t.j}</td>
      <td>${t.v}</td>
      <td>${t.e}</td>
      <td>${t.d}</td>
      <td>${t.gp}</td>
      <td>${t.gc}</td>
      <td>${sgStr}</td>
      <td>${t.pts}</td>
    </tr>
  `;
}
