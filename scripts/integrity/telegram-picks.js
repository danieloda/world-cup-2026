/**
 * Mensagens de Telegram com os palpites RECÉM-LACRADOS — postadas pela mesma
 * Action do snapshot (00:09 BRT), logo depois do relatório do lacre.
 *
 * Segurança por construção (decisão 2026-06-11, "alerta sem riscos"):
 *   - A fonte é o `content` do snapshot — só contém palpites de jogos JÁ
 *     TRAVADOS (deadline véspera 23h59 BRT). Não há query nova ao banco,
 *     logo não há como vazar palpite ainda editável.
 *   - Nomes vêm de content.users (full_name do app — o snapshot NUNCA exporta
 *     e-mail; guard em integrity-guards.test.js cobre este arquivo também).
 *   - "Travado no dia anterior" = diff de locked_match_ids com o snapshot
 *     ANTERIOR (mesma definição de "novo" do relatório). Lacre novo só por
 *     resultado lançado (sem jogo novo) → nenhuma mensagem.
 *   - Função PURA (dados → string[]): sem banco, sem fs, sem rede — testável
 *     em tests/unit/integrity-telegram-picks.test.js.
 *
 * KEEP IN SYNC: scripts/integrity/report.js (mesmo diff/nomes/formatos) e
 * snapshot.js (chamador — só depois do dedupe e do buildReport).
 */
import { teamPt } from '../../src/js/util.js';
import { fmtShort } from './report.js';

const STAGE_LABEL = {
  group: 'Grupos', r32: '32-avos', r16: 'Oitavas', qf: 'Quartas',
  sf: 'Semis', third: '3º Lugar', final: 'Final',
};

// parse_mode HTML: neutraliza nomes digitados pelo usuário antes de interpolar.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const teamPlain = (t) => (t ? teamPt(t) : 'A definir');

/**
 * Monta as mensagens (HTML do Telegram) com os palpites dos jogos que travaram
 * NESTE lacre, agrupados por placar. Respeita o teto de tamanho do Telegram
 * via `maxLen` (4096 oficial; default com folga para o envelope).
 *
 * @param {object} args
 * @param {object} args.entry        Entrada do manifest (seq).
 * @param {object} args.content      Conteúdo canônico do snapshot ATUAL.
 * @param {object|null} args.prevContent  Conteúdo do snapshot anterior.
 * @param {Array}  args.matches      Linhas de matches (id, stage, match_date,
 *                                   team_home, team_away) — nomes e horários.
 * @param {string} [args.reportUrl]  Link do relatório do lacre (rodapé).
 * @param {number} [args.maxLen]
 * @returns {string[]} mensagens prontas (vazio se nenhum jogo novo travou)
 */
export function buildPicksMessages({
  entry, content, prevContent, matches, reportUrl, maxLen = 3800,
}) {
  const prevSet = new Set(prevContent?.locked_match_ids ?? []);
  const newLocked = content.locked_match_ids.filter((id) => !prevSet.has(id));
  if (newLocked.length === 0) return [];

  const byId = new Map(matches.map((m) => [m.id, m]));
  const nameById = new Map((content.users ?? []).map((u) => [u.user_id, u.name]));
  const nameOf = (id) => nameById.get(id) || `Participante ${String(id).slice(0, 8)}…`;

  const predsByMatch = new Map();
  for (const p of content.predictions) {
    if (!predsByMatch.has(p.match_id)) predsByMatch.set(p.match_id, []);
    predsByMatch.get(p.match_id).push(p);
  }

  // Um bloco por jogo novo: título + uma linha por placar ("2×1 — Ana, Bia"),
  // placares mais palpitados primeiro (igual à leitura natural do grupo).
  const blocks = [];
  for (const id of newLocked) {
    const m = byId.get(id);
    const preds = predsByMatch.get(id) ?? [];
    if (preds.length === 0) continue;

    const groups = new Map();
    for (const p of preds) {
      let key = `${p.pred_home}×${p.pred_away}`;
      if (p.pred_pen_winner && m) key += ` · pên.: ${teamPlain(m[`team_${p.pred_pen_winner}`])}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(nameOf(p.user_id));
    }
    const lines = [...groups.entries()]
      .map(([score, names]) => [score, names.sort((a, b) => a.localeCompare(b, 'pt-BR'))])
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([score, names]) => `${esc(score)} — ${esc(names.join(', '))}`);

    const title = m
      ? `⚽ <b>${esc(teamPlain(m.team_home))} × ${esc(teamPlain(m.team_away))}</b>`
        + ` · ${esc(STAGE_LABEL[m.stage] || m.stage)} · ${esc(fmtShort(m.match_date))}`
      : `⚽ <b>Jogo #${id}</b>`;
    blocks.push([title, ...lines].join('\n'));
  }
  if (blocks.length === 0) return [];

  const header = (cont) => `🔓 <b>Palpites lacrados — lacre #${entry.seq}</b>${cont ? ' (cont.)' : ''}`;
  const intro = `${blocks.length} jogo(s) com prazo encerrado (véspera 23h59) — `
    + 'ninguém altera mais nada. Conforme publicado no relatório do lacre:';
  const footer = reportUrl
    ? `📄 <a href="${reportUrl}">Relatório do lacre #${entry.seq}</a>`
    : '';

  // Empacota blocos em mensagens <= maxLen (bloco individual nunca é quebrado:
  // com agrupamento por placar ele fica ordens de grandeza abaixo do teto).
  const messages = [];
  let cur = `${header(false)}\n${intro}`;
  for (const b of blocks) {
    if (`${cur}\n\n${b}`.length > maxLen) {
      messages.push(cur);
      cur = header(true);
    }
    cur += `\n\n${b}`;
  }
  if (footer) {
    if (`${cur}\n\n${footer}`.length > maxLen) {
      messages.push(cur);
      cur = `${header(true)}\n\n${footer}`;
    } else {
      cur += `\n\n${footer}`;
    }
  }
  messages.push(cur);
  return messages;
}
