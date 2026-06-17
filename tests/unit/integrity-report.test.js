// ============================================================
// Relatório legível por lacre (scripts/integrity/report.js).
//
// O relatório é o artefato que o organizador mostra a NÃO técnicos toda vez
// que jogos travam — então o que se testa aqui é a FIDELIDADE: os jogos novos
// aparecem com nome/fase/horário BRT certos, cada participante aparece pelo
// NOME DE USUÁRIO do app (nunca e-mail) com seu palpite, a auditoria de prazo
// acusa updated_at após o deadline, e os hashes/links de verificação estão no
// texto. A fórmula do prazo NÃO é reimplementada: o builder a recebe injetada,
// e o teste injeta a canônica de src/js/util.js (paridade já coberta em
// deadline-parity / integrity-guards).
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildReport, brtDateStamp, fmtBRT } from '../../scripts/integrity/report.js';
import { predictionDeadline } from '../../src/js/util.js';

const U1 = '11111111-aaaa-4bbb-8ccc-111111111111';
const U2 = '22222222-aaaa-4bbb-8ccc-222222222222';

// Nomes como no DB (canônicos, inglês) — o relatório exibe via teamPt.
// 11/06 17:00 BRT → prazo 10/06 23:59 BRT (= 2026-06-11T02:59:00Z)
const matches = [
  { id: 1, stage: 'group', match_date: '2026-06-11T20:00:00Z', team_home: 'Mexico', team_away: 'Poland' },
  { id: 2, stage: 'group', match_date: '2026-06-11T23:00:00Z', team_home: 'Canada', team_away: 'Senegal' },
  { id: 73, stage: 'r32', match_date: '2026-06-28T19:00:00Z', team_home: null, team_away: null },
  { id: 74, stage: 'r32', match_date: '2026-06-28T22:00:00Z', team_home: 'France', team_away: 'Brazil' },
  { id: 3, stage: 'group', match_date: '2026-06-20T19:00:00Z', team_home: 'Germany', team_away: 'Scotland' },
];

const entry = {
  seq: 6,
  file: 'snapshots/0006_2026-06-11T06-10-00-000Z.json',
  taken_at: '2026-06-11T06:10:00.000Z',
  content_hash: 'a'.repeat(64),
  prev_chain_hash: 'b'.repeat(64),
  chain_hash: 'c'.repeat(64),
  counts: { locked_matches: 4, predictions: 4, champion_picks: 2, scorer_picks: 1 },
};

const content = {
  version: 3,
  users: [
    { user_id: U1, name: 'Ana' },
    { user_id: U2, name: 'Bruno' },
  ],
  players: [{ id: 10, name: 'Kylian Mbappé', team: 'France' }],
  locked_match_ids: [1, 2, 73, 74],
  results: [],
  predictions: [
    { user_id: U1, match_id: 1, pred_home: 2, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-11T01:47:00Z' },
    { user_id: U2, match_id: 1, pred_home: 1, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U1, match_id: 2, pred_home: 0, pred_away: 3, pred_pen_winner: null, updated_at: '2026-06-10T18:30:00Z' },
    { user_id: U2, match_id: 74, pred_home: 1, pred_away: 1, pred_pen_winner: 'away', updated_at: '2026-06-10T12:00:00Z' },
  ],
  champion_picks: [
    { user_id: U1, team: 'Brazil', updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U2, team: 'France', updated_at: '2026-06-10T13:00:00Z' },
  ],
  scorer_picks: [{ user_id: U1, player_id: 10, updated_at: '2026-06-10T15:00:00Z' }],
};

const base = {
  entry, content, matches,
  prevContent: null,
  csDeadline: new Date('2026-06-11T02:59:00Z'),
  predictionDeadline,
  repoUrl: 'https://github.com/danieloda/world-cup-2026',
};

describe('jogos que travaram neste lacre', () => {
  const md = buildReport(base);

  it('linha do jogo: nomes traduzidos (teamPt), fase, horário e prazo em BRT, nº de palpites', () => {
    expect(md).toMatch(
      /\| \*\*México × Polônia\*\* \| Grupos \| qui 11\/06 17:00 \| qua 10\/06 23:59 \| 2 \| qua 10\/06 22:47 ✅ \|/,
    );
  });

  it('jogo de mata-mata sem confronto definido vira "A definir" com label da fase', () => {
    expect(md).toMatch(/\*A definir\* × \*A definir\*.*32-avos/);
  });

  it('jogo ainda não travado (fora de locked_match_ids) não aparece', () => {
    expect(md).not.toMatch(/Escócia|Scotland/);
  });

  it('diff com o lacre anterior: jogo já travado antes não entra na tabela de NOVOS', () => {
    const md2 = buildReport({ ...base, prevContent: { locked_match_ids: [1, 73, 74] } });
    // México (já travado antes) não é linha NOVA na tabela de jogos do lacre…
    expect(md2).not.toContain('| **México × Polônia**');
    // …mas continua no ledger completo de palpites lacrados.
    expect(md2).toContain('<b>México × Polônia</b>');
    expect(md2).toContain('| **Canadá × Senegal**');
    expect(md2).toContain('(1 novo(s) neste lacre)');
  });

  it('ledger lista os palpites de TODOS os jogos travados, mesmo sem jogo novo', () => {
    const md3 = buildReport({ ...base, prevContent: { locked_match_ids: [1, 2, 73, 74] } });
    expect(md3).toContain('Nenhum jogo novo travou desde o lacre anterior');
    expect(md3).toContain('## Palpites lacrados (todos os jogos travados até este lacre)');
    expect(md3).toContain('<b>México × Polônia</b> — abrir os 2 palpites lacrados');
    expect(md3).toContain('| Ana | 2×0 |');
  });

  it('sem jogo novo: explica que o lacre registra outra mudança', () => {
    const md3 = buildReport({ ...base, prevContent: { locked_match_ids: [1, 2, 73, 74] } });
    expect(md3).toContain('Nenhum jogo novo travou desde o lacre anterior');
  });
});

describe('palpites por participante — nome de usuário, nunca e-mail', () => {
  const md = buildReport(base);

  it('cada jogo novo tem tabela colapsável com nome + palpite, ordenada por nome', () => {
    expect(md).toContain('<b>México × Polônia</b> — abrir os 2 palpites lacrados');
    expect(md.indexOf('| Ana | 2×0 |')).toBeGreaterThan(-1);
    expect(md.indexOf('| Ana | 2×0 |')).toBeLessThan(md.indexOf('| Bruno | 1×1 |'));
  });

  it('palpite de mata-mata mostra o vencedor nos pênaltis traduzido', () => {
    expect(md).toContain('| Bruno | 1×1 · pên.: Brasil |');
  });

  it('picks de campeão/artilheiro estreiam COM nomes no lacre em que travaram', () => {
    expect(md).toContain('## Palpites de campeão e artilheiro (lacrados neste lacre)');
    expect(md).toContain('| Ana | Brasil |');
    expect(md).toContain('| Bruno | França |');
    expect(md).toContain('| Ana | Kylian Mbappé (França) |');
  });

  it('nos lacres seguintes os picks não são re-listados (só totais)', () => {
    const md2 = buildReport({
      ...base,
      prevContent: { locked_match_ids: [1], champion_picks: content.champion_picks, scorer_picks: content.scorer_picks },
    });
    expect(md2).not.toContain('## Palpites de campeão e artilheiro');
  });

  it('nome malicioso não injeta Markdown/HTML na tabela', () => {
    const evil = {
      ...content,
      users: [{ user_id: U1, name: '[hack](https://evil) | <img src=x>' }, { user_id: U2, name: 'Bruno' }],
    };
    const md2 = buildReport({ ...base, content: evil });
    expect(md2).not.toContain('[hack](https://evil)');
    expect(md2).not.toContain('<img src=x>');
  });

  it('usuário sem perfil lacrado ganha pseudônimo curto (não quebra o relatório)', () => {
    const noNames = { ...content, users: [] };
    const md2 = buildReport({ ...base, content: noNames });
    expect(md2).toContain(`Participante ${U1.slice(0, 8)}…`);
  });
});

describe('auditoria automática de prazo (updated_at lacrado ≤ deadline)', () => {
  it('tudo dentro do prazo → veredito ✅ citando o total de palpites', () => {
    const md = buildReport(base);
    expect(md).toContain('Nenhum dos 4 palpites lacrados foi registrado após o prazo');
    expect(md).not.toContain('APÓS o prazo');
  });

  it('palpite gravado após o prazo → ⚠️ com usuário, jogo e horas', () => {
    const dirty = {
      ...content,
      predictions: [
        ...content.predictions,
        { user_id: U2, match_id: 2, pred_home: 9, pred_away: 9, pred_pen_winner: null, updated_at: '2026-06-11T03:30:00Z' },
      ],
    };
    const md = buildReport({ ...base, content: dirty });
    expect(md).toContain('1 registro(s) com gravação APÓS o prazo');
    expect(md).toContain(`\`${U2.slice(0, 8)}…\``);
    expect(md).toContain('jogo #2');
  });

  it('pick de campeão gravado após o prazo dele também é acusado', () => {
    const dirty = {
      ...content,
      champion_picks: [{ user_id: U1, team: 'Brazil', updated_at: '2026-06-11T04:00:00Z' }],
    };
    const md = buildReport({ ...base, content: dirty });
    expect(md).toContain('pick de campeão');
  });

  // Jogo finalizado cujo updated_at (lacrado) é o instante da PONTUAÇÃO, não da
  // edição: assinatura = todas as predictions do jogo com o MESMO timestamp.
  const scoringStamped = {
    ...content,
    results: [{ match_id: 1, stage: 'group', status: 'FT', actual_home: 2, actual_away: 0, pen_winner: null }],
    predictions: [
      { user_id: U1, match_id: 1, pred_home: 2, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-12T15:00:00Z' },
      { user_id: U2, match_id: 1, pred_home: 1, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-12T15:00:00Z' },
    ],
  };

  it('jogo pontuado com updated_at uniforme = carimbo de scoring, NÃO acusa após o prazo', () => {
    const md = buildReport({ ...base, content: scoringStamped });
    expect(md).not.toContain('exigem explicação do organizador');
    expect(md).toContain('Nenhum dos 2 palpites lacrados foi registrado após o prazo');
    expect(md).toContain('1 jogo(s) já pontuado(s)');
    expect(md).toContain('🔧');
  });

  it('edição real pós-prazo (timestamp destoa do lote do scoring) ainda é acusada', () => {
    const mixed = {
      ...scoringStamped,
      predictions: [
        { user_id: U1, match_id: 1, pred_home: 2, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-12T15:00:00Z' },
        { user_id: U2, match_id: 1, pred_home: 9, pred_away: 9, pred_pen_winner: null, updated_at: '2026-06-12T18:30:00Z' },
      ],
    };
    const md = buildReport({ ...base, content: mixed });
    expect(md).toContain('registro(s) com gravação APÓS o prazo');
  });
});

describe('lacre, carimbos e instruções de verificação', () => {
  const md = buildReport(base);

  it('hashes completos do manifest aparecem no relatório', () => {
    expect(md).toContain(entry.content_hash);
    expect(md).toContain(entry.chain_hash);
    expect(md).toContain(entry.prev_chain_hash);
    expect(md).toContain(entry.file);
  });

  it('primeiro lacre da corrente não mostra hash anterior fantasma', () => {
    const md1 = buildReport({ ...base, entry: { ...entry, seq: 1, prev_chain_hash: '0'.repeat(64) } });
    expect(md1).toContain('este é o primeiro lacre da corrente');
  });

  it('instruções de verificação: comando público e links pro repositório', () => {
    expect(md).toContain('npm run integrity:verify');
    expect(md).toContain('https://github.com/danieloda/world-cup-2026/blob/main/integrity/snapshots/');
    expect(md).toContain('https://github.com/danieloda/world-cup-2026/commits/main/integrity');
  });

  it('totais: participantes distintos entre palpites e picks', () => {
    expect(md).toContain('Participantes com registros no lacre: **2**');
  });

  it('campeão/artilheiro ainda abertos → relatório diz quando travam', () => {
    const open = { ...content, champion_picks: [], scorer_picks: [] };
    const md4 = buildReport({ ...base, content: open });
    expect(md4).toContain('ainda abertos — travam em qua 10/06/2026 23:59 (BRT)');
  });
});

describe('helpers de data BRT (UTC-3 fixo)', () => {
  it('brtDateStamp usa o dia civil de Brasília, não o UTC', () => {
    expect(brtDateStamp('2026-06-11T06:10:00Z')).toBe('2026-06-11'); // 03:10 BRT
    expect(brtDateStamp('2026-06-11T01:00:00Z')).toBe('2026-06-10'); // 22:00 BRT da véspera
  });

  it('fmtBRT formata com dia da semana e marca o fuso', () => {
    expect(fmtBRT('2026-06-11T06:10:00Z')).toBe('qui 11/06/2026 03:10 (BRT)');
  });
});
