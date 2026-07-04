// @vitest-environment jsdom
//
// Dashboard da jornada (Início) — funções de cálculo puras + smoke de render.
// O smoke em jsdom cobre a classe de bug do incidente TDZ (06/15): módulo que
// avalia e renderiza sem crashar, com dados realistas mínimos.
import { describe, it, expect } from 'vitest';
import {
  ladderScenario, buildLadder, computeOvertakes, buildFunnel,
  buildVsAverage, buildLeaderGap, renderJourneyDashboard,
  computeKoStatus, buildChampionCard, buildScorerCard, buildPrizeCard,
  renderJourneyBets,
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

// ------------------------------------------------------------
// F2 — apostas vivas
// ------------------------------------------------------------
const ko = (over) => ({
  id: 0, stage: 'r32', match_date: '2026-06-29T16:00:00.000Z',
  team_home: 'Brazil', team_away: 'Mexico',
  actual_home: null, actual_away: null, pen_winner: null, finished: false, ...over,
});

const KO = [
  ko({ id: 101, actual_home: 2, actual_away: 0, finished: true }),               // Brasil elimina México
  ko({ id: 102, team_home: 'France', team_away: 'USA', match_date: '2026-06-29T19:00:00.000Z', actual_home: 1, actual_away: 1, pen_winner: 'away', finished: true }), // EUA nos pênaltis
  ko({ id: 103, stage: 'r16', match_date: '2026-07-06T16:00:00.000Z', team_home: 'Brazil', team_away: 'USA' }),
];

describe('computeKoStatus', () => {
  it('perdedor por gols e por pênalti; vivos têm próximo jogo', () => {
    const st = computeKoStatus(KO);
    expect(st.eliminated.has('Mexico')).toBe(true);
    expect(st.eliminated.has('France')).toBe(true);   // 1-1, pen 'away'
    expect(st.aliveForTitle('Brazil')).toBe(true);
    expect(st.upcoming.get('USA')?.id).toBe(103);
  });
  it('R32 todo semeado → quem não está nos 32 caiu nos grupos', () => {
    const st = computeKoStatus(KO);
    expect(st.r32Seeded).toBe(true);
    expect(st.aliveForTitle('Germany')).toBe(false);
  });
  it('R32 com vaga ainda em slot → NÃO afirma eliminação de grupo', () => {
    const st = computeKoStatus([...KO, ko({ id: 105, team_home: 'W12', team_away: 'Spain' })]);
    expect(st.r32Seeded).toBe(false);
    expect(st.aliveForTitle('Germany')).toBe(true);
  });
  it('empate finalizado sem pênalti registrado não elimina ninguém', () => {
    const st = computeKoStatus([ko({ id: 106, actual_home: 1, actual_away: 1, finished: true })]);
    expect(st.eliminated.size).toBe(0);
  });
  it('disputa de 3º: título morto, mas o time ainda joga (upcoming)', () => {
    const st = computeKoStatus([
      ko({ id: 107, stage: 'sf', actual_home: 0, actual_away: 3, finished: true }),   // Brasil perde a semi
      ko({ id: 108, stage: 'third', team_home: 'Brazil', team_away: 'France', match_date: '2026-07-17T16:00:00.000Z' }),
    ]);
    expect(st.aliveForTitle('Brazil')).toBe(false);
    expect(st.upcoming.has('Brazil')).toBe(true);
  });
});

describe('buildChampionCard', () => {
  const picks = [
    { user_id: 'me', team: 'Brazil' },
    { user_id: 'a', team: 'Brazil' },
    { user_id: 'ghost-nao-pago', team: 'Brazil' },
    { user_id: 'b', team: 'Mexico' },
  ];
  const paidIds = new Set(['me', 'a', 'b']);
  it('vivo com próximo jogo, contando só rivais pagos na torcida', () => {
    const c = buildChampionCard({ myPick: picks[0], allPicks: picks, koStatus: computeKoStatus(KO), meId: 'me', paidIds });
    expect(c.alive).toBe(true);
    expect(c.next?.id).toBe(103);
    expect(c.others).toBe(1);      // só 'a' (ghost não pagou)
    expect(c.bonus).toBe(40);
  });
  it('eliminado não tem próximo jogo', () => {
    const c = buildChampionCard({ myPick: { user_id: 'b', team: 'Mexico' }, allPicks: picks, koStatus: computeKoStatus(KO), meId: 'b', paidIds });
    expect(c.alive).toBe(false);
    expect(c.next).toBeNull();
  });
  it('sem pick ou sem koStatus (fetch falhou) → null', () => {
    expect(buildChampionCard({ myPick: null, allPicks: picks, koStatus: computeKoStatus(KO), meId: 'me', paidIds })).toBeNull();
    expect(buildChampionCard({ myPick: picks[0], allPicks: picks, koStatus: null, meId: 'me', paidIds })).toBeNull();
  });
  it('final finalizada com meu time vencedor → estado Campeão (won)', () => {
    const done = [...KO, ko({ id: 110, stage: 'final', match_date: '2026-07-19T19:00:00.000Z', team_home: 'Brazil', team_away: 'USA', actual_home: 1, actual_away: 1, pen_winner: 'home', finished: true })];
    const st = computeKoStatus(done);
    expect(st.champion).toBe('Brazil');
    const c = buildChampionCard({ myPick: picks[0], allPicks: picks, koStatus: st, meId: 'me', paidIds });
    expect(c.won).toBe(true);
    expect(c.alive).toBe(true); // venceu — nunca entrou em eliminated
  });
});

describe('buildScorerCard', () => {
  const feed = [
    { api_id: 9, name: 'Mbappé', team: 'France', goals: 6 },
    { api_id: 7, name: 'Vini Jr.', team: 'Brazil', goals: 4 },
  ];
  it('gap pro líder + multiplicador da fase do PRÓXIMO jogo do time', () => {
    const sc = buildScorerCard({ pick: { apiId: 7, name: 'Vini Jr.', team: 'Brazil' }, scorers: feed, koStatus: computeKoStatus(KO) });
    expect(sc.goals).toBe(4);
    expect(sc.rank).toBe(2);
    expect(sc.gap).toBe(2);
    expect(sc.stillPlays).toBe(true);
    expect(sc.perGoal).toBe(4);        // r16: 2 × 2.0
    expect(sc.finalPerGoal).toBe(10);  // final: 2 × 5.0
  });
  it('líder da corrida; pick fora do feed NÃO afirma contagem (top-N)', () => {
    const lead = buildScorerCard({ pick: { apiId: 9, name: 'Mbappé', team: 'France' }, scorers: feed, koStatus: computeKoStatus(KO) });
    expect(lead.isLeader).toBe(true);
    const out = buildScorerCard({ pick: { apiId: 999, name: 'Zagueiro', team: 'Brazil' }, scorers: feed, koStatus: computeKoStatus(KO) });
    expect(out.outsideFeed).toBe(true);
    expect(out.rank).toBeNull();
    expect(out.gap).toBeNull();
  });
  it('empate na ponta: rank de competição 1º + nome do empatado (sem "2º na corrida")', () => {
    const tied = [
      { api_id: 9, name: 'Mbappé', team: 'France', goals: 6 },
      { api_id: 7, name: 'Vini Jr.', team: 'Brazil', goals: 6 },
    ];
    const sc = buildScorerCard({ pick: { apiId: 7, name: 'Vini Jr.', team: 'Brazil' }, scorers: tied, koStatus: computeKoStatus(KO) });
    expect(sc.rank).toBe(1);
    expect(sc.isLeader).toBe(false);
    expect(sc.tiedWith).toBe('Mbappé');
    expect(sc.gap).toBe(0);
  });
  it('feed vazio ou koStatus null → null (nada a afirmar)', () => {
    expect(buildScorerCard({ pick: { apiId: 7, name: 'Vini Jr.', team: 'Brazil' }, scorers: [], koStatus: computeKoStatus(KO) })).toBeNull();
    expect(buildScorerCard({ pick: { apiId: 7, name: 'Vini Jr.', team: 'Brazil' }, scorers: feed, koStatus: null })).toBeNull();
  });
  it('time eliminado e sem jogo → os gols param; fallbackStage cobre vaga não semeada', () => {
    const sc = buildScorerCard({ pick: { apiId: 9, name: 'Mbappé', team: 'France' }, scorers: feed, koStatus: computeKoStatus(KO), fallbackStage: 'r32' });
    expect(sc.stillPlays).toBe(false);
    expect(sc.perGoal).toBe(3);        // fallback r32: 2 × 1.5
  });
});

describe('buildPrizeCard', () => {
  const row = (id, pts, exact = 0) => lbRow(id, id.toUpperCase(), { total_pts: pts, exact_count: exact });
  it('na zona: minha fatia com split padrão 70/20/10', () => {
    const pz = buildPrizeCard({ rows: [row('a', 100), row('b', 90), row('me', 85), row('c', 80)], meId: 'me', feeAmount: 50, paidUsers: 4 });
    expect(pz.totalPot).toBe(200);
    expect(pz.inZone).toBe(true);
    expect(pz.myPos).toBe(3);
    expect(pz.myShare).toBe(20);       // 10% de 200
  });
  it('fora da zona: aponta quem segura a última vaga paga e o gap', () => {
    const pz = buildPrizeCard({ rows: [row('a', 100), row('b', 90), row('d', 88), row('me', 85)], meId: 'me', feeAmount: 50, paidUsers: 4 });
    expect(pz.inZone).toBe(false);
    expect(pz.holder).toMatchObject({ pos: 3, gap: 3 });
  });
  it('empate no topo rateia (regra do prize.js) e desloca a zona', () => {
    const rows = [row('a', 100, 2), row('b', 100, 2), row('me', 80)];
    const pz = buildPrizeCard({ rows, meId: 'me', feeAmount: 100, paidUsers: 3 }); // pote 300 → [210,60,30]
    expect(pz.inZone).toBe(true);
    expect(pz.myPos).toBe(3);
    expect(pz.myShare).toBe(30);
  });
  it('fora do ranking → null', () => {
    expect(buildPrizeCard({ rows: [row('a', 10)], meId: 'ghost' })).toBeNull();
  });
  it('empate em pontos com o dono da vaga → gap 0 (copy trata como desempate)', () => {
    const rows = [row('a', 100), row('b', 90), row('d', 85, 5), row('me', 85, 2)];
    const pz = buildPrizeCard({ rows, meId: 'me', feeAmount: 50, paidUsers: 4 });
    expect(pz.inZone).toBe(false);
    expect(pz.holder.gap).toBe(0);
  });
  it('paid_users indisponível (0) cai no tamanho do leaderboard, não em pote R$ 0', () => {
    const pz = buildPrizeCard({ rows: [row('a', 100), row('me', 85)], meId: 'me', feeAmount: 50, paidUsers: 0 });
    expect(pz.totalPot).toBe(100);
  });
});

describe('renderJourneyBets (smoke jsdom)', () => {
  it('renderiza os 3 cards, revela o container e usa o plural certo', () => {
    const mount = document.createElement('div');
    mount.hidden = true;
    document.body.appendChild(mount);
    const ok = renderJourneyBets({
      mount,
      myChampionPick: { user_id: 'me', team: 'Brazil' },
      allChampionPicks: [
        { user_id: 'me', team: 'Brazil' },
        { user_id: 'a', team: 'Brazil' },
        { user_id: 'b', team: 'Brazil' },
      ],
      scorerPick: { apiId: 7, name: 'Vini Jr.', team: 'Brazil' },
      scorers: [{ api_id: 7, name: 'Vini Jr.', team: 'Brazil', goals: 4 }],
      koMatches: KO,
      leaderboard: LB,
      meId: 'me',
      settings: { prize_split: { first: 70, second: 20, third: 10 }, fee_amount: 50 },
      paidUsers: 6,
      nextStage: 'r32',
    });
    expect(ok).toBe(true);
    expect(mount.hidden).toBe(false);
    expect(mount.innerHTML).toContain('Seu campeão');
    expect(mount.innerHTML).toContain('Seu artilheiro');
    expect(mount.innerHTML).toContain('Zona de prêmio');
    expect(mount.innerHTML).toContain('+2 rivais na mesma torcida');
  });
  it('sem picks (usuário não escolheu) → só o card de prêmio', () => {
    const mount = document.createElement('div');
    mount.hidden = true;
    document.body.appendChild(mount);
    renderJourneyBets({
      mount, myChampionPick: null, allChampionPicks: [], scorerPick: null,
      scorers: [], koMatches: KO, leaderboard: LB, meId: 'me', paidUsers: 6,
    });
    expect(mount.hidden).toBe(false);
    expect(mount.innerHTML).not.toContain('Seu campeão');
    expect(mount.innerHTML).toContain('Zona de prêmio');
  });
  it('fetch de KO falhou (koMatches null) → sem afirmações de campeão/artilheiro', () => {
    const mount = document.createElement('div');
    mount.hidden = true;
    document.body.appendChild(mount);
    renderJourneyBets({
      mount,
      myChampionPick: { user_id: 'me', team: 'Brazil' },
      allChampionPicks: [{ user_id: 'me', team: 'Brazil' }],
      scorerPick: { apiId: 7, name: 'Vini Jr.', team: 'Brazil' },
      scorers: [{ api_id: 7, name: 'Vini Jr.', team: 'Brazil', goals: 4 }],
      koMatches: null,
      leaderboard: LB, meId: 'me', paidUsers: 6,
    });
    expect(mount.innerHTML).not.toContain('Seu campeão');
    expect(mount.innerHTML).not.toContain('Seu artilheiro');
    expect(mount.innerHTML).toContain('Zona de prêmio');
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
