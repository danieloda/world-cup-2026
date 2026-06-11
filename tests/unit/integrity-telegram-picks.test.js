// ============================================================
// Alerta de Telegram com os palpites recém-lacrados
// (scripts/integrity/telegram-picks.js).
//
// O que se garante aqui é a SEGURANÇA POR CONSTRUÇÃO do alerta (decisão
// 2026-06-11): só palpites de jogos que travaram NESTE lacre (mesmo diff do
// relatório — nada de palpite ainda editável), participantes pelo nome do app
// (nunca e-mail; nomes neutralizados p/ HTML), silêncio quando o lacre novo
// não tem jogo novo, e mensagens dentro do teto do Telegram (chunking).
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildPicksMessages } from '../../scripts/integrity/telegram-picks.js';

const U1 = '11111111-aaaa-4bbb-8ccc-111111111111';
const U2 = '22222222-aaaa-4bbb-8ccc-222222222222';
const U3 = '33333333-aaaa-4bbb-8ccc-333333333333';

// Nomes como no DB (canônicos, inglês) — a mensagem exibe via teamPt.
const matches = [
  { id: 1, stage: 'group', match_date: '2026-06-11T20:00:00Z', team_home: 'Mexico', team_away: 'Poland' },
  { id: 2, stage: 'group', match_date: '2026-06-11T23:00:00Z', team_home: 'Canada', team_away: 'Senegal' },
  { id: 74, stage: 'r32', match_date: '2026-06-28T22:00:00Z', team_home: 'France', team_away: 'Brazil' },
];

const entry = { seq: 7 };

const content = {
  version: 3,
  users: [
    { user_id: U1, name: 'Ana' },
    { user_id: U2, name: 'Bruno' },
  ],
  players: [],
  locked_match_ids: [1, 2, 74],
  results: [],
  predictions: [
    { user_id: U1, match_id: 1, pred_home: 2, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U2, match_id: 1, pred_home: 2, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U3, match_id: 1, pred_home: 0, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U1, match_id: 2, pred_home: 1, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U2, match_id: 74, pred_home: 1, pred_away: 1, pred_pen_winner: 'away', updated_at: '2026-06-10T12:00:00Z' },
  ],
  champion_picks: [],
  scorer_picks: [],
};

// Lacre anterior já tinha o 74 travado — os "novos" deste lacre são 1 e 2.
const prevContent = { locked_match_ids: [74] };

const base = {
  entry, content, matches, prevContent,
  reportUrl: 'https://github.com/danieloda/world-cup-2026/blob/main/integrity/reports/0007_2026-06-11.md',
};

describe('escopo — só o que travou NESTE lacre', () => {
  const msgs = buildPicksMessages(base);
  const all = msgs.join('\n');

  it('inclui os jogos novos com nome traduzido, fase e horário BRT', () => {
    expect(all).toContain('<b>México × Polônia</b> · Grupos · qui 11/06 17:00');
    expect(all).toContain('<b>Canadá × Senegal</b>');
  });

  it('NÃO inclui jogo travado em lacre anterior (França × Brasil) nem seu palpite', () => {
    expect(all).not.toContain('França');
    expect(all).not.toContain('pên.');
  });

  it('sem jogo novo (lacre só de resultado/campeão) → nenhuma mensagem', () => {
    expect(buildPicksMessages({ ...base, prevContent: { locked_match_ids: [1, 2, 74] } })).toEqual([]);
    // primeiro lacre (sem anterior) conta tudo como novo
    expect(buildPicksMessages({ ...base, prevContent: null }).join('\n')).toContain('França × Brasil');
  });
});

describe('conteúdo — agrupado por placar, nomes do app', () => {
  const all = buildPicksMessages(base).join('\n');

  it('agrupa por placar, mais palpitado primeiro, nomes em ordem pt-BR', () => {
    expect(all).toContain('2×1 — Ana, Bruno');
    const i21 = all.indexOf('2×1 — Ana, Bruno');
    const i00 = all.indexOf('0×0 — Participante');
    expect(i21).toBeGreaterThan(-1);
    expect(i00).toBeGreaterThan(i21); // 2 votos antes de 1 voto
  });

  it('usuário sem nome lacrado vira pseudônimo truncado (nunca o uuid inteiro)', () => {
    expect(all).toContain(`Participante ${U3.slice(0, 8)}…`);
    expect(all).not.toContain(U3);
  });

  it('pênaltis entram no placar quando palpitados (lacre genesis tem o jogo 74)', () => {
    const genesis = buildPicksMessages({ ...base, prevContent: null }).join('\n');
    expect(genesis).toContain('1×1 · pên.: Brasil — Bruno');
  });

  it('cabeçalho identifica o lacre e rodapé linka o relatório publicado', () => {
    expect(all).toContain('Palpites lacrados — lacre #7');
    expect(all).toContain(`<a href="${base.reportUrl}">Relatório do lacre #7</a>`);
  });
});

describe('higiene — HTML escapado e nada de e-mail', () => {
  it('nome malicioso não injeta HTML na mensagem', () => {
    const evil = {
      ...content,
      users: [{ user_id: U1, name: '<b>Hacker</b> & Cia' }, { user_id: U2, name: 'Bruno' }],
    };
    const all = buildPicksMessages({ ...base, content: evil }).join('\n');
    expect(all).toContain('&lt;b&gt;Hacker&lt;/b&gt; &amp; Cia');
    expect(all).not.toContain('<b>Hacker</b>');
  });

  it('a mensagem só usa dados do content lacrado (sem e-mail por construção)', () => {
    const all = buildPicksMessages(base).join('\n');
    expect(all).not.toMatch(/email|@.*\./i);
  });
});

describe('chunking — teto do Telegram', () => {
  it('maxLen apertado divide em várias mensagens, todas dentro do teto e com cabeçalho', () => {
    const msgs = buildPicksMessages({ ...base, prevContent: null, maxLen: 300 });
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(300);
      expect(m).toContain('Palpites lacrados — lacre #7');
    }
    // nenhum bloco se perde na divisão
    const all = msgs.join('\n');
    for (const t of ['México × Polônia', 'Canadá × Senegal', 'França × Brasil']) {
      expect(all).toContain(t);
    }
  });

  it('default folgado: tudo numa mensagem só', () => {
    expect(buildPicksMessages(base)).toHaveLength(1);
  });
});
