// @vitest-environment jsdom
//
// Dashboard da jornada (Início) — funções de cálculo puras + smoke de render.
// O smoke em jsdom cobre a classe de bug do incidente TDZ (06/15): módulo que
// avalia e renderiza sem crashar, com dados realistas mínimos.
import { describe, it, expect } from 'vitest';
import {
  ladderScenario, buildLadder, computeOvertakes, buildFunnel,
  buildVsAverage, buildLeaderGap, renderJourneyDashboard,
} from '../../src/js/journey-dashboard.js';

// ------------------------------------------------------------
// fixtures
// ------------------------------------------------------------
const lbRow = (user_id, full_name, over = {}) => ({
  user_id, full_name, paid: true,
  match_pts: 0, qualifier_pts: 0, scorer_pts: 0, champion_pts: 0,
  total_pts: 0, exact_count: 0, winner_sg_count: 0, winner_count: 0,
  side_count: 0, miss_count: 0, ...over,
});

const LB = [
  lbRow('a', 'Ana', { total_pts: 100, match_pts: 80, qualifier_pts: 10, scorer_pts: 10, exact_count: 6 }),
  lbRow('b', 'Beto', { total_pts: 90, match_pts: 90, exact_count: 5 }),
  lbRow('c', 'Carla', { total_pts: 88, match_pts: 88, exact_count: 4 }),
  lbRow('me', 'Você Teste', {
    total_pts: 85, match_pts: 60, qualifier_pts: 8, scorer_pts: 17,
    exact_count: 9, winner_sg_count: 16, winner_count: 21, side_count: 17, miss_count: 23,
  }),
  lbRow('d', 'Dudu', { total_pts: 84, match_pts: 84, exact_count: 2 }),
  lbRow('e', 'Edu', { total_pts: 60, match_pts: 60 }),
];

// 2 dias de jogos (18:00Z = 15:00 BRT — longe da virada de dia)
const MATCHES = [
  { id: 1, match_date: '2026-06-11T18:00:00.000Z', stage: 'group' },
  { id: 2, match_date: '2026-06-11T21:00:00.000Z', stage: 'group' },
  { id: 3, match_date: '2026-06-12T18:00:00.000Z', stage: 'group' },
  { id: 4, match_date: '2026-06-12T21:00:00.000Z', stage: 'group' },
];

// values[g+1] = pts após o jogo g (len = jogos + 1)
const SERIES = [
  { userId: 'me', name: 'Você Teste', avatar_url: null, values: [0, 5, 10, 10, 10] },
  { userId: 'x', name: 'Xandão', avatar_url: null, values: [0, 0, 5, 5, 12] },
  { userId: 'y', name: 'Yuri', avatar_url: null, values: [0, 8, 11, 11, 11] },
];

// ------------------------------------------------------------
describe('ladderScenario', () => {
  it('resultado certo só quando SOBRA ponto (empate em pts não passa)', () => {
    expect(ladderScenario(5, 'r32')).toBe('1 resultado certo (6 pts) e você passa');
    // gap == ave: empataria em pontos sem bumpar cravada → precisa da cravada
    expect(ladderScenario(6, 'r32')).toMatch(/cravada \(9 pts\) e você passa/);
  });
  it('no empate exato de pts, a cravada só passa se vencer o desempate de cravadas', () => {
    // minha cravada a mais supera o contador do rival (2+1 > 2) → passa
    expect(ladderScenario(9, 'r32', 2, 2)).toMatch(/cravada \(9 pts\) e você passa/);
    // rival tem 6 cravadas; 2+1 não alcança → só empata
    expect(ladderScenario(9, 'r32', 2, 6)).toMatch(/só empata — desempate: cravadas/);
    expect(ladderScenario(10, 'r32')).toMatch(/faltam 10 pts/);
  });
  it('devolve o feito MAIS BARATO nas fronteiras de desempate', () => {
    // grupo: ave 4, exact 7. gap == ave com mais cravadas MINHAS → o empate em
    // pontos já é meu no desempate nº 2; não precisa mandar cravar
    expect(ladderScenario(4, 'group', 5, 3)).toBe('1 resultado certo (4 pts) e você passa');
    // gap == exact e cravadas EMPATAM com a minha a mais (2+1 == 3):
    // decide a 3ª chave (venc.+saldo)
    expect(ladderScenario(7, 'group', 2, 3, 8, 2)).toMatch(/cravada \(7 pts\) e você passa/);
    expect(ladderScenario(7, 'group', 2, 3, 1, 2)).toMatch(/só empata/);
  });
  it('sem fase (copa encerrada) → sem cenário', () => {
    expect(ladderScenario(3, null)).toBeNull();
  });
});

describe('buildLadder', () => {
  it('2 acima + eu + 1 abaixo, com gaps e ameaça', () => {
    const l = buildLadder(LB, 'me', 'r32');
    expect(l.rungs.map(r => r.user_id)).toEqual(['b', 'c', 'me', 'd']);
    expect(l.rungs.map(r => r.pos)).toEqual([2, 3, 4, 5]);
    expect(l.rungs[0].gap).toBe(-5);
    expect(l.rungs[1].scenario).toMatch(/resultado certo/); // gap 3 < ave 6
    expect(l.rungs[3].gap).toBe(1);
    expect(l.rungs[3].threat).toBe(true); // ≤ 2 pts de gordura
  });
  it('empate em pontos desempata por cravadas (ordem canônica do bolão)', () => {
    const rows = [
      lbRow('p', 'P', { total_pts: 50, exact_count: 1 }),
      lbRow('q', 'Q', { total_pts: 50, exact_count: 3 }),
      lbRow('me', 'Eu', { total_pts: 40 }),
    ];
    const l = buildLadder(rows, 'me', 'group');
    expect(l.rungs.map(r => r.user_id)).toEqual(['q', 'p', 'me']);
  });
  it('líder: sem vizinho acima, flag isLeader', () => {
    const l = buildLadder(LB, 'a', 'r32');
    expect(l.isLeader).toBe(true);
    expect(l.rungs[0].user_id).toBe('a');
    expect(l.rungs[0].me).toBe(true);
  });
  it('usuário fora do ranking → null', () => {
    expect(buildLadder(LB, 'ghost', 'r32')).toBeNull();
  });
  it('não muta as linhas de entrada (assignRanksAndPrizes clona antes)', () => {
    const before = JSON.stringify(LB);
    buildLadder(LB, 'me', 'r32');
    expect(JSON.stringify(LB)).toBe(before);
  });
});

describe('computeOvertakes', () => {
  it('detecta quem cruzou comigo entre o penúltimo dia e agora', () => {
    const ot = computeOvertakes(SERIES, MATCHES, 'me');
    expect(ot.hasWindow).toBe(true);
    // X: dia 1 abaixo (5 < 10), fim acima (12 > 10) → me passou, +7 no dia
    expect(ot.passedMe.map(e => e.userId)).toEqual(['x']);
    expect(ot.passedMe[0].dayPts).toBe(7);
    // Y: acima antes e depois → não cruzou
    expect(ot.iPassed).toEqual([]);
    // meus pontos na janela (10 → 10) e rótulo do último dia com jogo
    expect(ot.myDayPts).toBe(0);
    expect(ot.windowLabel).toBe('12/6');
  });
  it('um dia só de jogos → sem janela', () => {
    const ot = computeOvertakes(SERIES.map(s => ({ ...s, values: s.values.slice(0, 3) })),
      MATCHES.slice(0, 2), 'me');
    expect(ot.hasWindow).toBe(false);
  });
  it('empate em pontos em qualquer ponta NÃO vira afirmação de ultrapassagem', () => {
    const withTies = [
      ...SERIES,
      // Z: atrás ontem (5 < 10), hoje EMPATA comigo (10 == 10) → empate
      // verdadeiro não é ultrapassagem (a Escada mostra a mesma posição)
      { userId: 'z', name: 'Zeca', avatar_url: null, values: [0, 0, 5, 5, 10] },
      // W: empatado ontem (10 == 10), hoje acima — indecidível ontem (não há
      // contadores históricos de desempate) → sem afirmação
      { userId: 'w', name: 'Wal', avatar_url: null, values: [0, 5, 10, 10, 12] },
    ];
    const ot = computeOvertakes(withTies, MATCHES, 'me');
    expect(ot.passedMe.map(e => e.userId)).toEqual(['x']); // só o cruzamento estrito
    expect(ot.iPassed).toEqual([]);
  });
  it('usuário sem série → null', () => {
    expect(computeOvertakes(SERIES, MATCHES, 'ghost')).toBeNull();
  });
});

describe('buildFunnel', () => {
  it('5 tiers na ordem do modelo, total = soma', () => {
    const f = buildFunnel(LB[3]);
    expect(f.segments.map(s => s.count)).toEqual([9, 16, 21, 17, 23]);
    expect(f.total).toBe(86);
  });
  it('sem standing → total 0', () => {
    expect(buildFunnel(null).total).toBe(0);
  });
});

describe('buildVsAverage', () => {
  it('média do bolão inclui o próprio usuário; pts/jogo divide por finalizados', () => {
    const rows = [lbRow('me', 'Eu', { total_pts: 100, exact_count: 4 }),
                  lbRow('o', 'Outro', { total_pts: 50, exact_count: 2 })];
    const v = buildVsAverage(rows, 'me', 10);
    expect(v.metrics[0].mine).toBe(10);      // 100/10
    expect(v.metrics[0].avg).toBe(7.5);      // (150/2)/10
    expect(v.metrics[1].avg).toBe(3);        // cravadas
    expect(v.metrics[2].avg).toBe(75);       // total
  });
  it('0 jogos finalizados não divide por zero', () => {
    const v = buildVsAverage([lbRow('me', 'Eu', { total_pts: 5 })], 'me', 0);
    expect(Number.isFinite(v.metrics[0].mine)).toBe(true);
  });
  it('behind conta só quem está ESTRITAMENTE atrás — empatado de verdade não', () => {
    const rows = [
      lbRow('me', 'Eu', { total_pts: 50, exact_count: 2 }),
      lbRow('t', 'Gêmeo', { total_pts: 50, exact_count: 2 }),   // empate nos 3 critérios
      lbRow('z', 'Zé', { total_pts: 40 }),
    ];
    expect(buildVsAverage(rows, 'me', 4).behind).toBe(1);       // só o Zé
    expect(buildVsAverage(LB, 'me', 12).behind).toBe(2);        // Dudu e Edu
  });
});

describe('buildLeaderGap', () => {
  it('deltas por pilar na perspectiva de quem olha (líder − eu)', () => {
    const lg = buildLeaderGap(LB, 'me');
    expect(lg.isLeader).toBe(false);
    expect(lg.other.name).toBe('Ana');
    const by = Object.fromEntries(lg.pillars.map(p => [p.label, p.delta]));
    expect(by.palpites).toBe(20);     // 80 − 60
    expect(by.vagas).toBe(2);         // 10 − 8
    expect(by.artilheiro).toBe(-7);   // 10 − 17 (eu na frente)
    expect(lg.gapTotal).toBe(15);     // 100 − 85
  });
  it('se eu sou o líder, compara com o vice e inverte o sinal', () => {
    const lg = buildLeaderGap(LB, 'a');
    expect(lg.isLeader).toBe(true);
    expect(lg.other.name).toBe('Beto');
    expect(lg.gapTotal).toBe(-10);    // 10 pts de frente
  });
  it('bolão de 1 jogador não quebra', () => {
    const lg = buildLeaderGap([lbRow('me', 'Eu', { total_pts: 5 })], 'me');
    expect(lg.isLeader).toBe(true);
    expect(lg.other).toBeNull();
  });
});

describe('renderJourneyDashboard (smoke jsdom)', () => {
  const mounts = () => {
    const layout = document.createElement('div');
    layout.className = 'jd-layout';
    const rail = document.createElement('aside');
    const dna = document.createElement('div');
    rail.hidden = true; dna.hidden = true;
    layout.appendChild(rail);
    document.body.append(layout, dna);
    return { layout, rail, dna };
  };

  it('renderiza os 5 widgets, revela os containers e liga o layout 2-colunas', () => {
    const { layout, rail, dna } = mounts();
    const ok = renderJourneyDashboard({
      railMount: rail, dnaMount: dna,
      series: SERIES, matches: MATCHES,
      leaderboard: LB, meId: 'me',
      nextStage: 'r32', finishedMatches: 4,
    });
    expect(ok).toBe(true);
    expect(rail.hidden).toBe(false);
    expect(dna.hidden).toBe(false);
    // grid 2-colunas só liga com trilho populado (senão reservaria 300px vazios)
    expect(layout.classList.contains('jd-on')).toBe(true);
    expect(rail.innerHTML).toContain('Escada do ranking');
    expect(rail.innerHTML).toContain('Ultrapassagens · 12/6');
    expect(dna.innerHTML).toContain('Funil de acertos');
    expect(dna.innerHTML).toContain('Você vs a média');
    expect(dna.innerHTML).toContain('O que te separa do líder');
  });

  it('nome malicioso não injeta HTML — nem no texto, nem nas iniciais do avatar', () => {
    const { rail, dna } = mounts();
    const evil = LB.map(r => r.user_id === 'b'
      ? { ...r, full_name: '<img src=x onerror=alert(1)>' } : r);
    renderJourneyDashboard({
      railMount: rail, dnaMount: dna,
      series: SERIES, matches: MATCHES,
      leaderboard: evil, meId: 'me',
      nextStage: 'r32', finishedMatches: 4,
    });
    expect(rail.querySelector('img[src="x"]')).toBeNull();
    expect(rail.textContent).toContain('<img');
    // iniciais "<S" do avatarHtml viram TEXTO (avatarHtml escapa), não tag —
    // uma tag bogus engoliria o </span> e corromperia o rung inteiro
    const avs = [...rail.querySelectorAll('.jd-av')];
    expect(avs.some(a => a.textContent.startsWith('<'))).toBe(true);
    expect(rail.querySelectorAll('.jd-av > *:not(img)').length).toBe(0);
  });

  it('rival empatado em pontos acima de você mostra "empate", não "+0" verde', () => {
    const { rail, dna } = mounts();
    // Carla empata comigo em pontos mas tem mais cravadas → fica ACIMA
    const tied = LB.map(r => r.user_id === 'c'
      ? { ...r, total_pts: 85, exact_count: 12 } : r);
    renderJourneyDashboard({
      railMount: rail, dnaMount: dna,
      series: SERIES, matches: MATCHES,
      leaderboard: tied, meId: 'me',
      nextStage: 'r32', finishedMatches: 4,
    });
    expect(rail.innerHTML).toContain('empate');
    expect(rail.innerHTML).not.toContain('+0');
  });

  it('falha interna não lança (contrato: gráfico nunca morre pelo dashboard)', () => {
    const { layout, rail, dna } = mounts();
    const ok = renderJourneyDashboard({
      railMount: rail, dnaMount: dna,
      series: null, matches: MATCHES,      // série quebrada de propósito
      leaderboard: LB, meId: 'me',
    });
    expect(ok).toBe(false);
    expect(rail.hidden).toBe(true);
    expect(layout.classList.contains('jd-on')).toBe(false); // gráfico segue full-width
  });
});
