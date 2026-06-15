import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  flag,
  decodeHtmlEntities,
  teamPt,
  groundPt,
  groundShort,
  roundLabelPt,
  getInitials,
  escapeHtml,
  greeting,
  firstName,
  formatBrShort,
  formatTime,
  stageLabel,
  computeStandings,
  isLive,
  isLocked,
  lockCountdownLabel,
  daysToKickoffLabel,
  brDayWindowUtc,
  oddsToProbs,
} from '../../src/js/util.js';

describe('flag', () => {
  // flag() retorna HTML da lib flag-icons (<span class="fi fi-xx">), não emoji.
  // Pra emoji unicode usa flagEmoji() (não testado aqui).
  it('returns correct flag-icons HTML for known teams', () => {
    expect(flag('Brazil')).toBe('<span class="fi fi-br"></span>');
    expect(flag('Argentina')).toBe('<span class="fi fi-ar"></span>');
    expect(flag('England')).toBe('<span class="fi fi-gb-eng"></span>');
    expect(flag('USA')).toBe('<span class="fi fi-us"></span>');
  });

  it('returns fallback for unknown teams', () => {
    expect(flag('Unknown Country')).toBe('<span class="fi fi-xx"></span>');
    expect(flag('Atlantis')).toBe('<span class="fi fi-xx"></span>');
  });

  it('handles HTML entities in team names', () => {
    expect(flag('Bosnia &amp; Herzegovina')).toBe('<span class="fi fi-ba"></span>');
  });

  it('handles null/undefined', () => {
    expect(flag(null)).toBe('<span class="fi fi-xx"></span>');
    expect(flag(undefined)).toBe('<span class="fi fi-xx"></span>');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes &amp; to &', () => {
    expect(decodeHtmlEntities('Bosnia &amp; Herzegovina')).toBe('Bosnia & Herzegovina');
  });

  it('decodes &lt; and &gt;', () => {
    expect(decodeHtmlEntities('&lt;script&gt;')).toBe('<script>');
  });

  it('decodes &quot; and &#39;', () => {
    expect(decodeHtmlEntities('&quot;hello&#39;')).toBe('"hello\'');
  });

  it('handles multiple entities', () => {
    expect(decodeHtmlEntities('&lt;a href=&quot;url&quot;&gt;')).toBe('<a href="url">');
  });

  it('returns null/undefined as-is', () => {
    expect(decodeHtmlEntities(null)).toBe(null);
    expect(decodeHtmlEntities(undefined)).toBe(undefined);
  });

  it('handles strings without entities', () => {
    expect(decodeHtmlEntities('Brazil')).toBe('Brazil');
  });
});

describe('teamPt', () => {
  it('translates team names to Portuguese', () => {
    expect(teamPt('Brazil')).toBe('Brasil');
    expect(teamPt('Germany')).toBe('Alemanha');
    expect(teamPt('Netherlands')).toBe('Países Baixos');
    expect(teamPt('South Korea')).toBe('Coreia do Sul');
  });

  it('returns original name if no translation', () => {
    expect(teamPt('Unknown Team')).toBe('Unknown Team');
  });

  it('handles HTML entities before translation', () => {
    expect(teamPt('Bosnia &amp; Herzegovina')).toBe('Bósnia e Herzegovina');
  });

  it('handles null/undefined', () => {
    expect(teamPt(null)).toBe(null);
    expect(teamPt(undefined)).toBe(undefined);
  });
});

describe('groundPt', () => {
  it('translates venue names', () => {
    expect(groundPt('Mexico City')).toBe('Cidade do México');
    expect(groundPt('Philadelphia')).toBe('Filadélfia');
  });

  it('returns original if no translation', () => {
    expect(groundPt('Atlanta')).toBe('Atlanta');
    expect(groundPt('Unknown Venue')).toBe('Unknown Venue');
  });

  it('handles null/undefined', () => {
    expect(groundPt(null)).toBe(null);
  });
});

describe('groundShort', () => {
  it('removes parenthetical part', () => {
    expect(groundShort('Los Angeles (Inglewood)')).toBe('Los Angeles');
    expect(groundShort('San Francisco Bay Area (Santa Clara)')).toBe('São Francisco');
  });

  it('handles venues without parentheses', () => {
    expect(groundShort('Atlanta')).toBe('Atlanta');
  });
});

describe('roundLabelPt', () => {
  it('translates Matchday labels', () => {
    expect(roundLabelPt('Matchday 1')).toBe('Rodada 1');
    expect(roundLabelPt('Matchday 3')).toBe('Rodada 3');
  });

  it('translates knockout rounds', () => {
    expect(roundLabelPt('Round of 32')).toBe('32-avos');
    expect(roundLabelPt('Round of 16')).toBe('Oitavas');
    expect(roundLabelPt('Quarter-final')).toBe('Quartas');
    expect(roundLabelPt('Semi-final')).toBe('Semifinais');
    expect(roundLabelPt('Final')).toBe('Final');
  });

  it('translates third place match', () => {
    expect(roundLabelPt('Match for third place')).toBe('Disputa do 3º Lugar');
  });

  it('returns unknown labels as-is', () => {
    expect(roundLabelPt('Unknown')).toBe('Unknown');
  });

  it('handles null/undefined', () => {
    expect(roundLabelPt(null)).toBe(null);
  });
});

describe('getInitials', () => {
  it('returns first letter of each word (max 2)', () => {
    expect(getInitials('John Doe')).toBe('JD');
    expect(getInitials('John Michael Doe')).toBe('JM');
  });

  it('handles single name', () => {
    expect(getInitials('John')).toBe('J');
  });

  it('handles empty/null input', () => {
    expect(getInitials('')).toBe('?');
    expect(getInitials(null)).toBe('?');
    expect(getInitials(undefined)).toBe('?');
  });

  it('handles extra whitespace', () => {
    expect(getInitials('  John   Doe  ')).toBe('JD');
  });

  it('uppercases initials', () => {
    expect(getInitials('john doe')).toBe('JD');
  });
});

describe('escapeHtml', () => {
  it('escapes special HTML characters', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('"quotes"')).toBe('&quot;quotes&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('handles null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('handles safe strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('greeting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns "Boa madrugada" before 6am', () => {
    vi.setSystemTime(new Date('2026-06-11T03:00:00'));
    expect(greeting()).toBe('Boa madrugada');
  });

  it('returns "Bom dia" between 6am and noon', () => {
    vi.setSystemTime(new Date('2026-06-11T09:00:00'));
    expect(greeting()).toBe('Bom dia');
  });

  it('returns "Boa tarde" between noon and 6pm', () => {
    vi.setSystemTime(new Date('2026-06-11T15:00:00'));
    expect(greeting()).toBe('Boa tarde');
  });

  it('returns "Boa noite" after 6pm', () => {
    vi.setSystemTime(new Date('2026-06-11T21:00:00'));
    expect(greeting()).toBe('Boa noite');
  });
});

describe('firstName', () => {
  it('returns first word', () => {
    expect(firstName('John Doe')).toBe('John');
  });

  it('returns "amigo" for null/empty', () => {
    expect(firstName(null)).toBe('amigo');
    expect(firstName('')).toBe('amigo');
  });

  it('handles extra whitespace', () => {
    expect(firstName('  John  ')).toBe('John');
  });
});

describe('formatBrShort', () => {
  it('formats date as DD/mon', () => {
    const d = new Date('2026-06-11T12:00:00');
    expect(formatBrShort(d)).toBe('11/jun');
  });

  it('handles different months', () => {
    // Use explicit time to avoid timezone issues
    expect(formatBrShort(new Date('2026-01-05T12:00:00'))).toBe('5/jan');
    expect(formatBrShort(new Date('2026-12-25T12:00:00'))).toBe('25/dez');
  });
});

describe('formatTime (renderiza em BRT, TZ de produção)', () => {
  it('converte kickoff UTC para o relógio de Brasília', () => {
    // match_date é gravado em UTC (jogo de abertura: 11/jun 19h UTC).
    // Usuário no Brasil deve ver 16:00 (UTC-3). Antes este teste só checava
    // o formato /\d{2}:\d{2}/ e mascarava o fuso — agora afirma o valor.
    expect(formatTime('2026-06-11T19:00:00+00:00')).toBe('16:00');
  });

  it('preserva o horário quando o input já vem em BRT', () => {
    expect(formatTime('2026-06-11T15:30:00-03:00')).toBe('15:30');
  });
});

describe('groundShort', () => {
  it('removes parenthetical part', () => {
    expect(groundShort('Dallas (Arlington)')).toBe('Dallas');
    expect(groundShort('Boston (Foxborough)')).toBe('Boston');
  });

  it('handles venues without parentheses', () => {
    expect(groundShort('Atlanta')).toBe('Atlanta');
  });

  it('handles empty/null', () => {
    expect(groundShort('')).toBe('');
    expect(groundShort(null)).toBe('');
  });
});

describe('stageLabel', () => {
  it('translates stage codes', () => {
    expect(stageLabel('group')).toBe('Grupos');
    expect(stageLabel('r32')).toBe('32-avos');
    expect(stageLabel('r16')).toBe('Oitavas');
    expect(stageLabel('qf')).toBe('Quartas');
    expect(stageLabel('sf')).toBe('Semis');
    expect(stageLabel('third')).toBe('3º Lugar');
    expect(stageLabel('final')).toBe('Final');
  });

  it('returns unknown stages as-is', () => {
    expect(stageLabel('unknown')).toBe('unknown');
  });
});

describe('computeStandings', () => {
  const makeMatch = (id, home, away, actualHome, actualAway, finished = true) => ({
    id,
    team_home: home,
    team_away: away,
    actual_home: actualHome,
    actual_away: actualAway,
    finished,
  });

  it('computes standings from real results', () => {
    const matches = [
      makeMatch(1, 'Brazil', 'Argentina', 2, 1),
      makeMatch(2, 'Brazil', 'Germany', 1, 1),
      makeMatch(3, 'Argentina', 'Germany', 0, 2),
    ];

    const standings = computeStandings(matches, 'real');

    // Brazil: W vs Argentina (2-1), D vs Germany (1-1) = 4pts, GF: 3, GA: 2, GD: +1
    // Germany: D vs Brazil (1-1), W vs Argentina (2-0) = 4pts, GF: 3, GA: 1, GD: +2
    // Argentina: L vs Brazil (1-2), L vs Germany (0-2) = 0pts, GD: -3

    // Sort: pts desc, sg desc → Germany first (better GD)
    expect(standings[0].team).toBe('Germany');
    expect(standings[0].pts).toBe(4);
    expect(standings[0].sg).toBe(2); // +2 GD

    expect(standings[1].team).toBe('Brazil');
    expect(standings[1].pts).toBe(4);
    expect(standings[1].v).toBe(1);
    expect(standings[1].e).toBe(1);
    expect(standings[1].sg).toBe(1); // +1 GD

    expect(standings[2].team).toBe('Argentina');
    expect(standings[2].pts).toBe(0);
  });

  it('ignores stats of unfinished matches in real mode', () => {
    const matches = [
      makeMatch(1, 'Brazil', 'Argentina', 2, 1, true),
      makeMatch(2, 'Brazil', 'Germany', null, null, false),
    ];

    const standings = computeStandings(matches, 'real');
    // Inicializa todos os times do grupo (intencional — ver comentário em util.js
    // "Initialize ALL teams from the group"), incluindo Germany. Mas não conta
    // stats do jogo não-finalizado.
    expect(standings.length).toBe(3);
    const germany = standings.find((s) => s.team === 'Germany');
    expect(germany).toBeDefined();
    expect(germany.j).toBe(0);
    expect(germany.pts).toBe(0);
    expect(germany.gp).toBe(0);

    const brazil = standings.find((s) => s.team === 'Brazil');
    expect(brazil.j).toBe(1);
    expect(brazil.pts).toBe(3); // só conta o match finalizado
  });

  it('computes standings from predictions in sim mode', () => {
    const matches = [
      { id: 1, team_home: 'Brazil', team_away: 'Argentina' },
      { id: 2, team_home: 'Brazil', team_away: 'Germany' },
    ];

    const preds = new Map([
      [1, { pred_home: 3, pred_away: 0 }],
      [2, { pred_home: 2, pred_away: 2 }],
    ]);

    const standings = computeStandings(matches, 'sim', preds);

    expect(standings[0].team).toBe('Brazil');
    expect(standings[0].pts).toBe(4); // 1W + 1D
    expect(standings[0].gp).toBe(5); // 3 + 2
  });

  it('sorts by pts, then SG, then GP, then name', () => {
    const matches = [
      makeMatch(1, 'A', 'B', 3, 0), // A wins 3-0
      makeMatch(2, 'C', 'D', 3, 0), // C wins 3-0
    ];

    const standings = computeStandings(matches, 'real');
    // Both have 3pts, +3 SG, 3 GP -> sort by name
    expect(standings[0].team).toBe('A');
    expect(standings[1].team).toBe('C');
  });

  it('breaks ties by FIFA rank when pts, SG and GF are all equal', () => {
    // Argentina(3) e Austria(24) empatam tudo (1-0 cada). Melhor FIFA = Argentina vem 1º.
    // Prova o tiebreaker oficial (migration 015) no front: pts→SG→GF→fifaRank.
    const matches = [
      makeMatch(1, 'Argentina', 'Jordan', 1, 0),
      makeMatch(2, 'Austria', 'Algeria', 1, 0),
    ];
    const standings = computeStandings(matches, 'real');
    // Argentina e Austria: ambos 3pts, +1 SG, 1 GF → desempate por FIFA (3 < 24)
    expect(standings[0].team).toBe('Argentina');
    expect(standings[1].team).toBe('Austria');
  });
});

describe('isLive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns false for finished matches', () => {
    const m = { finished: true, match_date: '2026-06-11T15:00:00Z' };
    expect(isLive(m)).toBe(false);
  });

  it('returns false before kickoff', () => {
    vi.setSystemTime(new Date('2026-06-11T14:00:00Z'));
    const m = { finished: false, match_date: '2026-06-11T15:00:00Z' };
    expect(isLive(m)).toBe(false);
  });

  it('returns true during match (within 2.5h of kickoff)', () => {
    vi.setSystemTime(new Date('2026-06-11T16:00:00Z'));
    const m = { finished: false, match_date: '2026-06-11T15:00:00Z' };
    expect(isLive(m)).toBe(true);
  });

  it('returns false after 2.5h window', () => {
    vi.setSystemTime(new Date('2026-06-11T18:00:00Z'));
    const m = { finished: false, match_date: '2026-06-11T15:00:00Z' };
    expect(isLive(m)).toBe(false);
  });
});

describe('isLocked (fecha 23h59 BRT da véspera)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Jogo: 15/jun 16h BRT = 15/jun 19:00 UTC → trava 14/jun 23h59 BRT = 15/jun 02:59 UTC.
  const m = { match_date: '2026-06-15T19:00:00Z' };

  it('aberto bem antes da véspera', () => {
    vi.setSystemTime(new Date('2026-06-14T12:00:00Z')); // 14/jun 09h BRT
    expect(isLocked(m)).toBe(false);
  });

  it('aberto 1 minuto antes do prazo', () => {
    vi.setSystemTime(new Date('2026-06-15T02:58:00Z')); // 14/jun 23h58 BRT
    expect(isLocked(m)).toBe(false);
  });

  it('travado no prazo (23h59 BRT da véspera)', () => {
    vi.setSystemTime(new Date('2026-06-15T02:59:00Z')); // 14/jun 23h59 BRT
    expect(isLocked(m)).toBe(true);
  });

  it('travado no dia do jogo (antes do apito)', () => {
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z')); // 15/jun 09h BRT, jogo só 16h
    expect(isLocked(m)).toBe(true);
  });
});

describe('lockCountdownLabel (conta até o bloqueio, não até o jogo)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Jogo: 15/jun 16h BRT = 15/jun 19:00 UTC → trava 14/jun 23h59 BRT = 15/jun 02:59 UTC.
  const m = { match_date: '2026-06-15T19:00:00Z' };

  it('mostra dias até o bloqueio (não até o jogo)', () => {
    vi.setSystemTime(new Date('2026-06-12T02:59:00Z')); // 11/jun 23h59 BRT → faltam 3 dias p/ travar
    expect(lockCountdownLabel(m.match_date)).toBe('Bloqueia em 3 dias');
  });

  it('singular para 1 dia', () => {
    vi.setSystemTime(new Date('2026-06-14T02:59:00Z')); // 13/jun 23h59 BRT → 1 dia
    expect(lockCountdownLabel(m.match_date)).toBe('Bloqueia em 1 dia');
  });

  it('mostra horas quando falta menos de 1 dia', () => {
    vi.setSystemTime(new Date('2026-06-14T22:59:00Z')); // 14/jun 19h59 BRT → 4h
    expect(lockCountdownLabel(m.match_date)).toBe('Bloqueia em 4h');
  });

  it('"Bloqueado" após o prazo', () => {
    vi.setSystemTime(new Date('2026-06-15T03:00:00Z')); // já passou 23h59 BRT da véspera
    expect(lockCountdownLabel(m.match_date)).toBe('Bloqueado');
  });
});

describe('daysToKickoffLabel (dias civis BRT até a estreia — 11/jun 16h BRT)', () => {
  it('véspera de manhã: "amanhã", NÃO "Faltam 2 dias" (bug do Math.ceil de 30h)', () => {
    // 10/jun 10:00 BRT — faltam 30h corridas até o kickoff, mas é 1 dia de calendário.
    expect(daysToKickoffLabel(new Date('2026-06-10T13:00:00Z'))).toBe('A Copa começa amanhã!');
  });

  it('véspera 00:00 BRT: ainda "amanhã"', () => {
    expect(daysToKickoffLabel(new Date('2026-06-10T03:00:00Z'))).toBe('A Copa começa amanhã!');
  });

  it('véspera 23:59 BRT: ainda "amanhã"', () => {
    expect(daysToKickoffLabel(new Date('2026-06-11T02:59:00Z'))).toBe('A Copa começa amanhã!');
  });

  it('dia da estreia (00:00 BRT): título neutro', () => {
    expect(daysToKickoffLabel(new Date('2026-06-11T03:00:00Z'))).toBe('Copa do Mundo 2026');
  });

  it('2 dias antes: plural correto', () => {
    expect(daysToKickoffLabel(new Date('2026-06-09T12:00:00Z'))).toBe('Faltam 2 dias');
  });

  it('depois da estreia: título neutro', () => {
    expect(daysToKickoffLabel(new Date('2026-07-01T12:00:00Z'))).toBe('Copa do Mundo 2026');
  });
});

describe('brDayWindowUtc (janela do dia civil de Brasília, em UTC)', () => {
  it('16:00 BRT de 11/jun → [03:00Z 11/jun, 02:59:59.999Z 12/jun]', () => {
    const w = brDayWindowUtc(new Date('2026-06-11T19:00:00Z'));
    expect(w.startIso).toBe('2026-06-11T03:00:00.000Z');
    expect(w.endIso).toBe('2026-06-12T02:59:59.999Z');
  });

  it('22:00 BRT de 11/jun (já 12/jun em UTC) → continua na janela de 11/jun', () => {
    const w = brDayWindowUtc(new Date('2026-06-12T01:00:00Z'));
    expect(w.startIso).toBe('2026-06-11T03:00:00.000Z');
  });

  it('00:00 BRT de 12/jun → vira a janela', () => {
    const w = brDayWindowUtc(new Date('2026-06-12T03:00:00Z'));
    expect(w.startIso).toBe('2026-06-12T03:00:00.000Z');
  });
});

describe('oddsToProbs', () => {
  // 1/odd de cada resultado, normalizado pela soma (remove a margem da casa).
  it('converte odds em probabilidades que somam ~100%', () => {
    const p = oddsToProbs({ odd_home: 1.90, odd_draw: 3.40, odd_away: 4.20 });
    expect(Math.round(p.pHome + p.pDraw + p.pAway)).toBe(100);
    // 1/1.9=.5263, 1/3.4=.2941, 1/4.2=.2381 → soma 1.0585 → 49.7/27.8/22.5
    expect(p.pHome).toBeCloseTo(49.7, 0);
    expect(p.pDraw).toBeCloseTo(27.8, 0);
    expect(p.pAway).toBeCloseTo(22.5, 0);
    expect(p.favored).toBe('home');
  });

  it('marca empate como favorito quando a odd do empate é a menor', () => {
    const p = oddsToProbs({ odd_home: 3.50, odd_draw: 2.10, odd_away: 3.60 });
    expect(p.favored).toBe('draw');
  });

  it('marca visitante como favorito quando a odd de fora é a menor', () => {
    const p = oddsToProbs({ odd_home: 4.00, odd_draw: 3.50, odd_away: 1.85 });
    expect(p.favored).toBe('away');
  });

  it('retorna null para odds inválidas (<= 1, zero, ausentes, NaN)', () => {
    expect(oddsToProbs({ odd_home: 1.0, odd_draw: 3.4, odd_away: 4.2 })).toBeNull();
    expect(oddsToProbs({ odd_home: 0, odd_draw: 3.4, odd_away: 4.2 })).toBeNull();
    expect(oddsToProbs({ odd_home: 1.9, odd_draw: 3.4 })).toBeNull();
    expect(oddsToProbs({ odd_home: 'x', odd_draw: 3.4, odd_away: 4.2 })).toBeNull();
    expect(oddsToProbs(null)).toBeNull();
    expect(oddsToProbs(undefined)).toBeNull();
  });

  it('odds equilibradas → probabilidades equilibradas', () => {
    const p = oddsToProbs({ odd_home: 3.0, odd_draw: 3.0, odd_away: 3.0 });
    expect(p.pHome).toBeCloseTo(33.33, 1);
    expect(p.pDraw).toBeCloseTo(33.33, 1);
    expect(p.pAway).toBeCloseTo(33.33, 1);
  });
});

describe('seleções B (reserva) — bandeira e nome do país', () => {
  it('flag("Ghana B") usa a bandeira de Gana', () => {
    expect(flag('Ghana B')).toBe('<span class="fi fi-gh"></span>');
  });
  it('teamPt("Ghana B") traduz o país e mantém o B', () => {
    expect(teamPt('Ghana B')).toBe('Gana B');
  });
  it('não afeta times normais', () => {
    expect(flag('Ghana')).toBe('<span class="fi fi-gh"></span>');
    expect(teamPt('Ghana')).toBe('Gana');
    expect(flag('Unknown')).toBe('<span class="fi fi-xx"></span>');
  });
});

describe('loadTopScorers', () => {
  // O loader cacheia em escopo de módulo; resetModules + import dinâmico dão uma
  // instância nova (cache zerado) a cada teste, sem vazar estado entre eles.
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const stubFetch = (impl) => vi.stubGlobal('fetch', vi.fn(impl));

  it('carrega e normaliza topscorers.json', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({
      updated_at: '2026-06-15T00:00:00Z', season: 2026,
      scorers: [{ api_id: 978, name: 'K. Havertz', team: 'Germany', goals: 2, assists: 0 }],
    }) }));
    const { loadTopScorers } = await import('../../src/js/util.js');
    const res = await loadTopScorers();
    expect(res.updated_at).toBe('2026-06-15T00:00:00Z');
    expect(res.scorers).toHaveLength(1);
    expect(res.scorers[0].api_id).toBe(978);
  });

  it('cacheia — não refaz o fetch na 2ª chamada', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ updated_at: 'x', scorers: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { loadTopScorers } = await import('../../src/js/util.js');
    await loadTopScorers();
    await loadTopScorers();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HTTP não-ok → degrada para vazio', async () => {
    stubFetch(async () => ({ ok: false, status: 500 }));
    const { loadTopScorers } = await import('../../src/js/util.js');
    expect(await loadTopScorers()).toEqual({ updated_at: null, scorers: [] });
  });

  it('fetch rejeitando → degrada para vazio', async () => {
    stubFetch(async () => { throw new Error('network'); });
    const { loadTopScorers } = await import('../../src/js/util.js');
    expect((await loadTopScorers()).scorers).toEqual([]);
  });

  it('campos ausentes no JSON → fallback null/[]', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({}) }));
    const { loadTopScorers } = await import('../../src/js/util.js');
    expect(await loadTopScorers()).toEqual({ updated_at: null, scorers: [] });
  });
});
