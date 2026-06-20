// ============================================================
// Fair play (conduta) — fórmula OFICIAL da FIFA p/ desempate da Copa 2026.
// ============================================================
// Pontos de conduta por JOGADOR, por jogo (mais alto = melhor):
//   1º amarelo .......................... −1
//   2º amarelo (vermelho indireto) ...... −3   (total do jogador; não soma o −1)
//   vermelho direto ..................... −4
//   amarelo + vermelho direto ........... −5
// O fair play de um time num jogo é a soma das deduções dos seus jogadores.
//
// FONTE dos cartões: API-Football GET /fixtures/events (type='Card', detail=
// 'Yellow Card' | 'Red Card' | 'Second Yellow card'). Premissa de leitura: o
// 2º amarelo vem como um SEGUNDO evento 'Yellow Card' (ou 'Second Yellow card')
// — logo dois amarelos do mesmo jogador = vermelho indireto (−3). Um 'Yellow'
// + um 'Red Card' (sem rótulo "second") é tratado como amarelo + vermelho
// direto (−5). Computado UMA vez na ingestão e guardado em matches.*_fairplay,
// então o desempate (SQL/JS) só soma valores prontos.

/**
 * Dedução de fair play de UM jogador, a partir dos `detail` dos seus eventos
 * de cartão no jogo.
 * @param {string[]} details
 * @returns {number} ≤ 0
 */
export function playerFairPlay(details) {
  const d = (details || []).map((x) => String(x || '').toLowerCase());
  const plainYellows = d.filter((x) => x.includes('yellow') && !x.includes('second')).length;
  const secondYellow = d.some((x) => x.includes('second yellow')) || plainYellows >= 2;
  const directRed = d.some((x) => x.includes('red') && !x.includes('second'));

  if (secondYellow) return -3;                        // 2 amarelos → vermelho indireto
  if (directRed) return plainYellows >= 1 ? -5 : -4;  // amarelo+vermelho direto, ou vermelho seco
  if (plainYellows === 1) return -1;                  // amarelo simples
  return 0;
}

/**
 * Agrega os eventos de cartão de um jogo num resumo por lado (home/away).
 * @param {Array<{type?:string, detail?:string, team?:{name?:string}, player?:{id?:number|string, name?:string}}>} events
 * @param {string} homeName  nome do mandante no padrão da API (p/ casar event.team.name)
 * @param {string} awayName  nome do visitante no padrão da API
 * @returns {{home:{yellow:number,red:number,fairplay:number}, away:{yellow:number,red:number,fairplay:number}}}
 */
export function summarizeCards(events, homeName, awayName) {
  const mk = () => ({ byPlayer: new Map(), yellow: 0, red: 0 });
  const sides = { home: mk(), away: mk() };

  for (const ev of events || []) {
    if (ev?.type !== 'Card') continue;
    const teamName = ev.team?.name;
    const side = teamName === homeName ? sides.home : teamName === awayName ? sides.away : null;
    if (!side) continue;  // evento de outro time (não deveria ocorrer) → ignora

    const low = String(ev.detail || '').toLowerCase();
    if (low.includes('yellow')) side.yellow++;
    else if (low.includes('red')) side.red++;

    const key = ev.player?.id ?? ev.player?.name ?? `anon-${side.byPlayer.size}`;
    if (!side.byPlayer.has(key)) side.byPlayer.set(key, []);
    side.byPlayer.get(key).push(ev.detail);
  }

  const fairplay = (side) => {
    let total = 0;
    for (const details of side.byPlayer.values()) total += playerFairPlay(details);
    return total;
  };

  return {
    home: { yellow: sides.home.yellow, red: sides.home.red, fairplay: fairplay(sides.home) },
    away: { yellow: sides.away.yellow, red: sides.away.red, fairplay: fairplay(sides.away) },
  };
}
