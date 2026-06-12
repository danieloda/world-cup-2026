/**
 * Mensagens de Telegram com o RAIO-X dos palpites RECÉM-LACRADOS — postadas
 * pela mesma Action do snapshot (00:09 BRT), logo depois do relatório do lacre.
 *
 * Em vez de listar palpite por palpite (poluição — a lista completa segue no
 * relatório do lacre, linkado no rodapé), a mensagem traz estatísticas de
 * engajamento (decisão 2026-06-12):
 *   - por jogo: divisão vitória/empate/vitória (pênaltis contados no mata-mata),
 *     "placar da galera" (mais cravado), apostas solitárias (🐺), unanimidade,
 *     aposta de campeão em campo (🏆) e quem apostou contra o próprio campeão (🙃);
 *   - ranking: top 3, duelo líder × vice nos jogos que travaram (com o swing
 *     máximo de pontos) e a lanterna (🐢);
 *   - extras: gêmeos do lacre (👯, placares idênticos em tudo), promessa de
 *     gols / jogo trancado (🚿/🧱) e o palpite mais ousado (🎲).
 *
 * Segurança por construção (decisão 2026-06-11, "alerta sem riscos"):
 *   - A fonte é o `content` do snapshot — só contém palpites de jogos JÁ
 *     TRAVADOS (deadline véspera 23h59 BRT). Não há query nova ao banco,
 *     logo não há como vazar palpite ainda editável.
 *   - Nomes vêm de content.users (full_name do app — o snapshot NUNCA exporta
 *     e-mail; guard em integrity-guards.test.js cobre este arquivo também).
 *   - O ranking é DERIVADO do mesmo content (results + predictions lacrados),
 *     com a pontuação do SSOT puro src/js/scoring.js — sem fonte externa.
 *   - "Travado no dia anterior" = diff de locked_match_ids com o snapshot
 *     ANTERIOR (mesma definição de "novo" do relatório). Lacre novo só por
 *     resultado lançado (sem jogo novo) → nenhuma mensagem.
 *   - Função PURA (dados → string[]): sem banco, sem fs, sem rede — testável
 *     em tests/unit/integrity-telegram-picks.test.js.
 *
 * KEEP IN SYNC: scripts/integrity/report.js (mesmo diff de "novo" e mesmos
 * nomes; a lista palpite-a-palpite vive lá) e snapshot.js (chamador — só
 * depois do dedupe e do buildReport).
 */
import { teamPt } from '../../src/js/util.js';
import { scorePrediction, matchPoints } from '../../src/js/scoring.js';
import { fmtShort } from './report.js';

const STAGE_LABEL = {
  group: 'Grupos', r32: '32-avos', r16: 'Oitavas', qf: 'Quartas',
  sf: 'Semis', third: '3º Lugar', final: 'Final',
};

// Estatísticas de "uma pessoa só" e "todo mundo" só fazem graça (e sentido)
// com uma amostra mínima — em pool de 2-3 palpites tudo é solitário.
const MIN_POOL = 4;

// parse_mode HTML: neutraliza nomes digitados pelo usuário antes de interpolar.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const teamPlain = (t) => (t ? teamPt(t) : 'A definir');
const pts = (n) => `${n} pt${n === 1 ? '' : 's'}`;

// Resultado apontado por um palpite: 'h'/'d'/'a' — empate de mata-mata é
// decidido pelo palpite de pênaltis (mesma leitura do scoring/SQL).
function predOutcome(p, stage) {
  if (p.pred_home > p.pred_away) return { side: 'h', pen: false };
  if (p.pred_away > p.pred_home) return { side: 'a', pen: false };
  const pen = p.pred_pen_winner;
  if (stage !== 'group' && pen) {
    return { side: (pen === 'away' || pen === 'a') ? 'a' : 'h', pen: true };
  }
  return { side: 'd', pen: false };
}

const matchName = (m) => `${teamPlain(m?.team_home)} × ${teamPlain(m?.team_away)}`;

// "Ana e Bruno" / "Ana, Bruno e Carlos" — ordem pt-BR, determinística.
const nameList = (names) => {
  const s = [...names].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return s.length <= 1 ? (s[0] ?? '') : `${s.slice(0, -1).join(', ')} e ${s[s.length - 1]}`;
};

// Bloco de um jogo: título + estatísticas (nunca a lista de palpites).
function gameBlock(m, id, preds, nameOf, champs) {
  const stage = m?.stage ?? 'group';
  const home = teamPlain(m?.team_home);
  const away = teamPlain(m?.team_away);
  const n = preds.length;

  // Título em duas linhas + linha em branco antes das estatísticas — respiro
  // visual no chat (feedback 2026-06-12).
  const title = m
    ? `⚽ <b>${esc(home)} × ${esc(away)}</b>\n${esc(STAGE_LABEL[m.stage] || m.stage)} · ${esc(fmtShort(m.match_date))}`
    : `⚽ <b>Jogo #${id}</b>`;
  const lines = [title, ''];

  // Divisão por resultado — no mata-mata, vitória nos pênaltis conta pro lado
  // e ganha a anotação; "Empate 0" só aparece onde empate existe (grupos).
  const count = { h: 0, d: 0, a: 0 };
  const penCount = { h: 0, a: 0 };
  for (const p of preds) {
    const o = predOutcome(p, stage);
    count[o.side]++;
    if (o.pen) penCount[o.side]++;
  }
  const sideTxt = (side, label) => {
    const pen = side !== 'd' && penCount[side]
      ? ` (${penCount[side]} nos pênaltis)` : '';
    return `${esc(label)} ${count[side]}${pen}`;
  };
  const showDraw = stage === 'group' || count.d > 0;
  const split = [
    sideTxt('h', home),
    showDraw ? sideTxt('d', 'Empate') : null,
    sideTxt('a', away),
  ].filter(Boolean).join(' · ');
  lines.push(`🗳 ${n} palpite${n === 1 ? '' : 's'} — ${split}`);

  // Placar da galera (mais cravado) — ou o caos de ninguém combinar nada.
  const scores = new Map();
  for (const p of preds) {
    let key = `${p.pred_home}×${p.pred_away}`;
    if (p.pred_pen_winner && m) key += ` · pên.: ${teamPlain(m[`team_${p.pred_pen_winner}`])}`;
    scores.set(key, (scores.get(key) ?? 0) + 1);
  }
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topCount = ranked[0][1];
  if (topCount >= 2) {
    const top = ranked.filter(([, c]) => c === topCount).map(([s]) => s);
    // "palpitaram", nunca "cravaram" — cravar soa como acerto de jogo já
    // disputado (feedback 2026-06-12).
    lines.push(top.length === 1
      ? `🔥 Placar da galera: ${esc(top[0])} (${topCount} palpitaram)`
      : `🔥 Placares da galera: ${esc(top.join(' e '))} (${topCount} cada)`);
  } else if (n >= MIN_POOL) {
    lines.push(`🎯 ${n} palpites, ${n} placares diferentes — ninguém combinou nada`);
  }

  // Unanimidade ou apostas solitárias — com os pontos de resultado em jogo.
  if (n >= MIN_POOL) {
    const { ave } = matchPoints(stage);
    const label = { h: `${home} vence`, d: 'empate', a: `${away} vence` };
    const sidesUsed = ['h', 'd', 'a'].filter((s) => count[s] > 0);
    if (sidesUsed.length === 1) {
      lines.push(`🤜🤛 Unanimidade: todo mundo de “${esc(label[sidesUsed[0]])}” — zebra aqui não poupa ninguém`);
    } else {
      for (const side of sidesUsed) {
        if (count[side] !== 1) continue;
        const lone = preds.find((p) => predOutcome(p, stage).side === side);
        lines.push(`🐺 Aposta solitária: só ${esc(nameOf(lone.user_id))} foi de “${esc(label[side])}” — ${pts(ave)} exclusivos se acertar`);
      }
    }
  }

  // Aposta de campeão em campo: quem tem um dos dois times como campeão da
  // Copa torce dobrado hoje (nomes quando são poucos; contagem quando não).
  if (m && champs) {
    const inField = [m.team_home, m.team_away]
      .map((team) => ({ team, fans: champs.byTeam.get(team) ?? [] }))
      .filter((x) => x.fans.length > 0);
    if (inField.length) {
      const part = (x) => {
        const who = x.fans.length <= 2
          ? nameList(x.fans.map((u) => nameOf(u)))
          : `${x.fans.length} pessoas`;
        return `${teamPlain(x.team)} (${who})`;
      };
      lines.push(`🏆 Aposta de campeão em campo: ${esc(inField.map(part).join(' · '))}`);
    }

    // Quem palpitou DERROTA do time que escolheu como campeão (empate não
    // conta — frieza de verdade é dar a vitória pro rival).
    const coldFeet = [];
    for (const p of preds) {
      const champ = champs.byUser.get(p.user_id);
      if (!champ || (champ !== m.team_home && champ !== m.team_away)) continue;
      const side = predOutcome(p, stage).side;
      const champSide = champ === m.team_home ? 'h' : 'a';
      if (side !== champSide && side !== 'd') {
        coldFeet.push(`${nameOf(p.user_id)} (${teamPlain(champ)})`);
      }
    }
    if (coldFeet.length) {
      lines.push(`🙃 Contra o próprio campeão: ${esc(coldFeet.sort((a, b) => a.localeCompare(b, 'pt-BR')).join(', '))}`);
    }
  }

  return lines.join('\n');
}

// Ranking derivado do próprio content lacrado: results + predictions com a
// pontuação por jogo do SSOT (scoring.js). Bônus de fim de torneio (campeão/
// artilheiro/classificados) ficam fora — aqui o assunto são os JOGOS.
function standings(content, nameOf) {
  const resByMatch = new Map(content.results.map((r) => [r.match_id, r]));
  if (resByMatch.size === 0) return [];
  const total = new Map();
  for (const p of content.predictions) {
    const r = resByMatch.get(p.match_id);
    if (!r) continue;
    const v = scorePrediction(
      p.pred_home, p.pred_away, p.pred_pen_winner,
      r.actual_home, r.actual_away, r.pen_winner, r.stage,
    );
    total.set(p.user_id, (total.get(p.user_id) ?? 0) + v);
  }
  return [...total.entries()]
    .sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0]), 'pt-BR'));
}

// Bloco "Olho no ranking": top 3 + duelo líder × vice nos jogos deste lacre.
function rankingBlock({ content, newLocked, byId, predsByMatch, nameOf }) {
  const table = standings(content, nameOf);
  if (table.length < 2 || !table.some(([, p]) => p > 0)) return null;

  const medals = ['🥇', '🥈', '🥉'];
  let podium = table.slice(0, 3)
    .map(([uid, p], i) => `${medals[i]} ${esc(nameOf(uid))} ${pts(p)}`)
    .join('\n');
  // Empate além do pódio: com poucos jogos, meio pelotão divide o 3º lugar —
  // esconder isso faria o pódio parecer mais exclusivo do que é.
  if (table.length > 3) {
    const third = table[2][1];
    const extra = table.slice(3).filter(([, p]) => p === third).length;
    if (extra > 0) podium += `\n(+${extra} empatado${extra === 1 ? '' : 's'} com ${pts(third)})`;
  }
  const lines = ['📈 <b>Olho no ranking</b>', '', podium];

  const [[u1, p1], [u2, p2]] = table;
  const gap = p1 - p2;
  const gapTxt = gap === 0 ? 'empatados na ponta' : `${pts(gap)} de diferença`;
  const duel = [];
  let comparable = 0;
  for (const id of newLocked) {
    const preds = predsByMatch.get(id) ?? [];
    const a = preds.find((p) => p.user_id === u1);
    const b = preds.find((p) => p.user_id === u2);
    if (!a || !b) continue;
    comparable++;
    if (a.pred_home !== b.pred_home || a.pred_away !== b.pred_away
      || a.pred_pen_winner !== b.pred_pen_winner) duel.push(id);
  }
  if (duel.length) {
    const swing = duel.reduce(
      (s, id) => s + matchPoints(byId.get(id)?.stage ?? 'group').exact, 0,
    );
    const where = duel.length === 1
      ? esc(matchName(byId.get(duel[0])))
      : `${duel.length} jogos deste lacre`;
    lines.push('', `⚔️ Duelo do topo: ${esc(nameOf(u1))} × ${esc(nameOf(u2))} (${gapTxt}) palpitaram diferente em ${where} — até ${pts(swing)} de swing${swing > gap ? '. A liderança está em jogo!' : ''}`);
  } else if (comparable > 0) {
    const tail = gap === 0
      ? 'seguem colados, empatados na ponta'
      : `${pts(gap)} de diferença segue intacta`;
    lines.push('', `🤝 Duelo do topo: ${esc(nameOf(u1))} e ${esc(nameOf(u2))} palpitaram IGUAL nos jogos deste lacre — ${tail}`);
  }

  // Lanterna — tradição de bolão. Só com pelotão de verdade (4+) e quando
  // existe de fato um fundo da tabela (sem empate geral).
  if (table.length >= 4) {
    const minPts = table[table.length - 1][1];
    if (minPts < p1) {
      const bottom = table.filter(([, p]) => p === minPts).map(([uid]) => nameOf(uid));
      const who = bottom.length <= 2
        ? nameList(bottom)
        : `${bottom.length} empatados`;
      lines.push('', `🐢 Lanterna: ${esc(who)} (${pts(minPts)}) — todo campeão já foi lanterna um dia`);
    }
  }

  return lines.join('\n');
}

// Gêmeos do lacre: quem cravou EXATAMENTE os mesmos placares em todos os
// jogos que travaram (só faz graça com 2+ jogos no lacre).
function twinsLine({ newLocked, predsByMatch, nameOf }) {
  const gameIds = newLocked.filter((id) => (predsByMatch.get(id) ?? []).length > 0);
  if (gameIds.length < 2) return null;

  const perUser = new Map();
  for (const id of gameIds) {
    for (const p of predsByMatch.get(id)) {
      if (!perUser.has(p.user_id)) perUser.set(p.user_id, new Map());
      perUser.get(p.user_id).set(id, `${p.pred_home}×${p.pred_away}|${p.pred_pen_winner ?? ''}`);
    }
  }
  const groups = new Map();
  for (const [uid, picks] of perUser) {
    if (picks.size !== gameIds.length) continue; // só quem palpitou tudo
    const key = gameIds.map((id) => picks.get(id)).join(';');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(nameOf(uid));
  }
  const twins = [...groups.values()].filter((g) => g.length >= 2).map(nameList)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  // Só é notícia quando é RARO: com poucos jogos e muita gente, colisão de
  // placares é a norma (visto no lacre #7: 15 grupos de "gêmeos" em 75) — aí
  // a linha vira spam, não graça.
  if (!twins.length || twins.length > 2) return null;
  return `👯 Gêmeos do lacre: ${esc(twins.join('; '))} fizeram exatamente os mesmos palpites em todos os jogos`;
}

// Expectativa de gols: o jogo que a galera enxerga aberto (média alta) e o
// que enxerga trancado (média baixa) — só com 2+ jogos pra comparar.
function goalsLines({ newLocked, byId, predsByMatch }) {
  const stats = [];
  for (const id of newLocked) {
    const preds = predsByMatch.get(id) ?? [];
    if (preds.length === 0) continue;
    const avg = preds.reduce((s, p) => s + p.pred_home + p.pred_away, 0) / preds.length;
    stats.push({ id, avg });
  }
  if (stats.length < 2) return [];
  stats.sort((a, b) => b.avg - a.avg || a.id - b.id);
  const fmtAvg = (v) => v.toFixed(1).replace('.', ',');

  const lines = [];
  const hi = stats[0];
  const lo = stats[stats.length - 1];
  if (hi.avg >= 2.5) {
    lines.push(`🚿 Promessa de gols: ${esc(matchName(byId.get(hi.id)))} — a galera espera ${fmtAvg(hi.avg)} gols de média`);
  }
  if (lo.avg <= 1.5 && lo.id !== hi.id) {
    lines.push(`🧱 Jogo trancado: ${esc(matchName(byId.get(lo.id)))} — média de só ${fmtAvg(lo.avg)} gols nos palpites`);
  }
  return lines;
}

// Palpite mais ousado do lacre (maior soma de gols, a partir de 5).
function boldestLine({ newLocked, byId, predsByMatch, nameOf }) {
  let bold = null;
  for (const id of newLocked) {
    for (const p of predsByMatch.get(id) ?? []) {
      const total = p.pred_home + p.pred_away;
      if (total >= 5 && (!bold || total > bold.total)) bold = { p, id, total };
    }
  }
  if (!bold) return null;
  return `🎲 Palpite mais ousado do lacre: ${bold.p.pred_home}×${bold.p.pred_away} de ${esc(nameOf(bold.p.user_id))} em ${esc(matchName(byId.get(bold.id)))}`;
}

/**
 * Monta as mensagens (HTML do Telegram) com o raio-X dos palpites dos jogos
 * que travaram NESTE lacre. Respeita o teto de tamanho do Telegram via
 * `maxLen` (4096 oficial; default com folga para o envelope).
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

  // Picks de campeão (já lacrados quando presentes no content) — indexados
  // por time (torcida dobrada) e por usuário (contra o próprio campeão).
  const champs = { byTeam: new Map(), byUser: new Map() };
  for (const c of content.champion_picks ?? []) {
    if (!champs.byTeam.has(c.team)) champs.byTeam.set(c.team, []);
    champs.byTeam.get(c.team).push(c.user_id);
    champs.byUser.set(c.user_id, c.team);
  }

  const blocks = [];
  for (const id of newLocked) {
    const preds = predsByMatch.get(id) ?? [];
    if (preds.length === 0) continue;
    blocks.push(gameBlock(byId.get(id), id, preds, nameOf, champs));
  }
  const gameCount = blocks.length;
  if (gameCount === 0) return [];

  const ctx = { content, newLocked, byId, predsByMatch, nameOf };
  const ranking = rankingBlock(ctx);
  if (ranking) blocks.push(ranking);

  const extras = [twinsLine(ctx), ...goalsLines(ctx), boldestLine(ctx)].filter(Boolean);
  if (extras.length) blocks.push(['🍿 <b>Extras do lacre</b>', '', extras.join('\n\n')].join('\n'));

  const header = (cont) => `🔓 <b>Palpites lacrados — lacre #${entry.seq}</b>${cont ? ' (cont.)' : ''}`;
  const intro = `${gameCount} jogo(s) com prazo encerrado (véspera 23h59) — ninguém altera mais nada.\n`
    + 'Raio-X do que a galera palpitou:';
  // Link sempre puro e visível (feedback 2026-06-12; mesma linha da migração
  // 045, que força cta_label = cta_url nos alertas do bolão).
  const footer = reportUrl
    ? `📄 Palpite por palpite no relatório do lacre #${entry.seq}:\n${reportUrl}`
    : '';

  // Empacota blocos em mensagens <= maxLen (bloco individual nunca é quebrado:
  // são poucas linhas de estatística, ordens de grandeza abaixo do teto).
  const messages = [];
  let cur = `${header(false)}\n\n${intro}`;
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
