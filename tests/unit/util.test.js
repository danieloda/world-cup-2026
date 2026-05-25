import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  shortGround,
  stageLabel,
  computeStandings,
  isLive,
  isLocked,
} from '../../js/util.js';

describe('flag', () => {
  it('returns correct flag for known teams', () => {
    expect(flag('Brazil')).toBe('🇧🇷');
    expect(flag('Argentina')).toBe('🇦🇷');
    expect(flag('England')).toBe('🏴󠁧󠁢󠁥󠁮󠁧󠁿');
    expect(flag('USA')).toBe('🇺🇸');
  });

  it('returns default flag for unknown teams', () => {
    expect(flag('Unknown Country')).toBe('🏳️');
    expect(flag('Atlantis')).toBe('🏳️');
  });

  it('handles HTML entities in team names', () => {
    expect(flag('Bosnia &amp; Herzegovina')).toBe('🇧🇦');
  });

  it('handles null/undefined', () => {
    expect(flag(null)).toBe('🏳️');
    expect(flag(undefined)).toBe('🏳️');
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

describe('formatTime', () => {
  it('formats ISO time as HH:MM', () => {
    const result = formatTime('2026-06-11T15:30:00-03:00');
    // Time zone handling may vary, just check format
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('shortGround', () => {
  it('removes parenthetical part', () => {
    expect(shortGround('Dallas (Arlington)')).toBe('Dallas');
    expect(shortGround('Boston (Foxborough)')).toBe('Boston');
  });

  it('handles venues without parentheses', () => {
    expect(shortGround('Atlanta')).toBe('Atlanta');
  });

  it('handles empty/null', () => {
    expect(shortGround('')).toBe('');
    expect(shortGround(null)).toBe('');
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

  it('ignores unfinished matches in real mode', () => {
    const matches = [
      makeMatch(1, 'Brazil', 'Argentina', 2, 1, true),
      makeMatch(2, 'Brazil', 'Germany', null, null, false),
    ];

    const standings = computeStandings(matches, 'real');
    expect(standings.length).toBe(2);
    expect(standings.find(s => s.team === 'Germany')).toBeUndefined();
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

describe('isLocked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns false before kickoff', () => {
    vi.setSystemTime(new Date('2026-06-11T14:00:00Z'));
    const m = { match_date: '2026-06-11T15:00:00Z' };
    expect(isLocked(m)).toBe(false);
  });

  it('returns true at kickoff', () => {
    vi.setSystemTime(new Date('2026-06-11T15:00:00Z'));
    const m = { match_date: '2026-06-11T15:00:00Z' };
    expect(isLocked(m)).toBe(true);
  });

  it('returns true after kickoff', () => {
    vi.setSystemTime(new Date('2026-06-11T16:00:00Z'));
    const m = { match_date: '2026-06-11T15:00:00Z' };
    expect(isLocked(m)).toBe(true);
  });
});
