// ============================================================
// Alerta de Telegram com o raio-X dos palpites recém-lacrados
// (scripts/integrity/telegram-picks.js).
//
// O que se garante aqui é a SEGURANÇA POR CONSTRUÇÃO do alerta (decisão
// 2026-06-11): só palpites de jogos que travaram NESTE lacre (mesmo diff do
// relatório — nada de palpite ainda editável), participantes pelo nome do app
// (nunca e-mail; nomes neutralizados p/ HTML), silêncio quando o lacre novo
// não tem jogo novo, e mensagens dentro do teto do Telegram (chunking).
//
// E o FORMATO de engajamento (decisão 2026-06-12): estatísticas por jogo
// (divisão de resultado, placar da galera, aposta solitária, unanimidade) +
// bloco de ranking (top 3 derivado do content lacrado via scoring SSOT,
// duelo líder × vice, palpite mais ousado) — a lista palpite-a-palpite
// vive no relatório do lacre, só linkado no rodapé.
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildPicksMessages } from '../../scripts/integrity/telegram-picks.js';

const U1 = '11111111-aaaa-4bbb-8ccc-111111111111'; // Ana    (líder: 7 pts)
const U2 = '22222222-aaaa-4bbb-8ccc-222222222222'; // Bruno  (vice: 5 pts)
const U3 = '33333333-aaaa-4bbb-8ccc-333333333333'; // Carlos (1 pt)
const U4 = '44444444-aaaa-4bbb-8ccc-444444444444'; // Dani   (0 pts)
const U5 = '55555555-aaaa-4bbb-8ccc-555555555555'; // sem nome lacrado

// Nomes como no DB (canônicos, inglês) — a mensagem exibe via teamPt.
const matches = [
  { id: 1, stage: 'group', match_date: '2026-06-11T20:00:00Z', team_home: 'Mexico', team_away: 'Poland' },
  { id: 2, stage: 'group', match_date: '2026-06-11T23:00:00Z', team_home: 'Canada', team_away: 'Senegal' },
  { id: 3, stage: 'group', match_date: '2026-06-09T20:00:00Z', team_home: 'Argentina', team_away: 'Chile' },
  { id: 74, stage: 'r32', match_date: '2026-06-28T22:00:00Z', team_home: 'France', team_away: 'Brazil' },
];

const entry = { seq: 7 };

const content = {
  version: 3,
  users: [
    { user_id: U1, name: 'Ana' },
    { user_id: U2, name: 'Bruno' },
    { user_id: U3, name: 'Carlos' },
    { user_id: U4, name: 'Dani' },
  ],
  players: [],
  locked_match_ids: [1, 2, 3, 74],
  // Jogo 3 já tem resultado (1×0) → alimenta o ranking derivado:
  // Ana cravou (7), Bruno acertou vencedor+saldo (5), Carlos um lado (1), Dani 0.
  results: [
    { match_id: 3, stage: 'group', status: 'finished', actual_home: 1, actual_away: 0, pen_winner: null },
  ],
  predictions: [
    // Jogo 1: 3 com o México (2×1 é a moda), Carlos sozinho no empate,
    // U5 (sem nome) sozinho com a Polônia.
    { user_id: U1, match_id: 1, pred_home: 2, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U2, match_id: 1, pred_home: 2, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U4, match_id: 1, pred_home: 3, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U3, match_id: 1, pred_home: 0, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U5, match_id: 1, pred_home: 0, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    // Jogo 2: unanimidade no Canadá, nenhum placar repetido, 4×2 é a ousadia.
    { user_id: U1, match_id: 2, pred_home: 1, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U2, match_id: 2, pred_home: 2, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U3, match_id: 2, pred_home: 2, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    { user_id: U4, match_id: 2, pred_home: 4, pred_away: 2, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
    // Jogo 3 (travado em lacre anterior, com resultado 1×0).
    { user_id: U1, match_id: 3, pred_home: 1, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-08T12:00:00Z' },
    { user_id: U2, match_id: 3, pred_home: 2, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-08T12:00:00Z' },
    { user_id: U3, match_id: 3, pred_home: 0, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-08T12:00:00Z' },
    { user_id: U4, match_id: 3, pred_home: 0, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-08T12:00:00Z' },
    // Jogo 74 (travado em lacre anterior): empate decidido nos pênaltis.
    { user_id: U2, match_id: 74, pred_home: 1, pred_away: 1, pred_pen_winner: 'away', updated_at: '2026-06-10T12:00:00Z' },
  ],
  // Campeão lacrado: Ana e Carlos têm a Polônia (que joga o 1 — e Ana apostou
  // CONTRA ela!), Dani tem o Canadá (que joga o 2).
  champion_picks: [
    { user_id: U1, team: 'Poland', updated_at: '2026-06-01T12:00:00Z' },
    { user_id: U3, team: 'Poland', updated_at: '2026-06-01T12:00:00Z' },
    { user_id: U4, team: 'Canada', updated_at: '2026-06-01T12:00:00Z' },
  ],
  scorer_picks: [],
};

// Lacre anterior já tinha 3 e 74 travados — os "novos" deste lacre são 1 e 2.
const prevContent = { locked_match_ids: [3, 74] };

const base = {
  entry, content, matches, prevContent,
  reportUrl: 'https://github.com/danieloda/world-cup-2026/blob/main/integrity/reports/0007_2026-06-11.md',
};

describe('escopo — só o que travou NESTE lacre vira bloco de jogo', () => {
  const msgs = buildPicksMessages(base);
  const all = msgs.join('\n');

  it('inclui os jogos novos com nome traduzido, fase e horário BRT', () => {
    expect(all).toContain('<b>México × Polônia</b> · Grupos · qui 11/06 17:00');
    expect(all).toContain('<b>Canadá × Senegal</b>');
  });

  it('NÃO inclui bloco de jogo travado em lacre anterior (França/Argentina)', () => {
    expect(all).not.toContain('França');
    expect(all).not.toContain('Argentina');
  });

  it('sem jogo novo (lacre só de resultado/campeão) → nenhuma mensagem', () => {
    expect(buildPicksMessages({ ...base, prevContent: { locked_match_ids: [1, 2, 3, 74] } })).toEqual([]);
    // primeiro lacre (sem anterior) conta tudo como novo
    expect(buildPicksMessages({ ...base, prevContent: null }).join('\n')).toContain('França × Brasil');
  });
});

describe('estatísticas por jogo — sem lista de palpites', () => {
  const all = buildPicksMessages(base).join('\n');

  it('divisão por resultado com contagem (vitória / empate / vitória)', () => {
    expect(all).toContain('🗳 5 palpites — México 3 · Empate 1 · Polônia 1');
    expect(all).toContain('🗳 4 palpites — Canadá 4 · Empate 0 · Senegal 0');
  });

  it('placar da galera = placar mais cravado, com contagem', () => {
    expect(all).toContain('🔥 Placar da galera: 2×1 (2 cravaram)');
  });

  it('aposta solitária nomeia quem está sozinho num resultado e os pts em jogo', () => {
    expect(all).toContain('🐺 Aposta solitária: só Carlos foi de “empate” — 4 pts exclusivos se acertar');
    expect(all).toContain('só Participante 55555555… foi de “Polônia vence”');
    expect(all).not.toContain(U5); // nunca o uuid inteiro
  });

  it('unanimidade quando todo mundo aponta o mesmo resultado', () => {
    expect(all).toContain('🤜🤛 Unanimidade: todo mundo de “Canadá vence”');
  });

  it('nenhum placar repetido vira estatística de caos (não lista placares)', () => {
    expect(all).toContain('🎯 4 palpites, 4 placares diferentes');
  });

  it('NÃO lista palpite por palpite (formato antigo: "2×1 — Ana, Bruno")', () => {
    expect(all).not.toMatch(/×\d+ — \w/);
    expect(all).not.toContain('2×1 — Ana');
  });

  it('mata-mata: vitória nos pênaltis conta pro lado, com anotação (lacre genesis tem o jogo 74)', () => {
    const genesis = buildPicksMessages({ ...base, prevContent: null }).join('\n');
    expect(genesis).toContain('🗳 1 palpite — França 0 · Brasil 1 (1 nos pênaltis)');
  });

  it('aposta de campeão em campo: nomes quando poucos, time traduzido', () => {
    expect(all).toContain('🏆 Aposta de campeão em campo: Polônia (Ana e Carlos)');
    expect(all).toContain('🏆 Aposta de campeão em campo: Canadá (Dani)');
  });

  it('contra o próprio campeão: só quem deu VITÓRIA ao rival (empate não conta)', () => {
    // Ana tem Polônia como campeã e cravou 2×1 pro México.
    expect(all).toContain('🙃 Contra o próprio campeão: Ana (Polônia)');
    // Carlos também tem a Polônia, mas foi de empate — não entra.
    expect(all).not.toContain('Carlos (Polônia)');
  });
});

describe('bloco de ranking — derivado do content lacrado (scoring SSOT)', () => {
  const all = buildPicksMessages(base).join('\n');

  it('top 3 com pontos calculados dos resultados lacrados', () => {
    expect(all).toContain('🥇 Ana 7 pts · 🥈 Bruno 5 pts · 🥉 Carlos 1 pt');
  });

  it('duelo líder × vice: onde divergem nos jogos novos e o swing máximo', () => {
    expect(all).toContain('⚔️ Duelo do topo: Ana × Bruno (2 pts de diferença) palpitaram diferente em Canadá × Senegal — até 7 pts de swing. A liderança está em jogo!');
  });

  it('palpite mais ousado do lacre (maior soma de gols)', () => {
    expect(all).toContain('🎲 Palpite mais ousado do lacre: 4×2 de Dani em Canadá × Senegal');
  });

  it('sem resultado lançado ainda → sem bloco de ranking (e sem erro)', () => {
    const noResults = { ...content, results: [] };
    const all0 = buildPicksMessages({ ...base, content: noResults }).join('\n');
    expect(all0).toContain('México × Polônia'); // jogos continuam
    expect(all0).not.toContain('Olho no ranking');
    expect(all0).not.toContain('🥇');
  });

  it('líderes com palpites iguais nos jogos novos → diferença "segue intacta" + gêmeos do lacre', () => {
    // Bruno copia os palpites da Ana nos jogos 1 e 2.
    const copycat = {
      ...content,
      predictions: content.predictions.map((p) => (
        p.user_id === U2 && (p.match_id === 1 || p.match_id === 2)
          ? { ...p, pred_home: p.match_id === 1 ? 2 : 1, pred_away: p.match_id === 1 ? 1 : 0 }
          : p
      )),
    };
    const all2 = buildPicksMessages({ ...base, content: copycat }).join('\n');
    expect(all2).toContain('🤝 Duelo do topo: Ana e Bruno palpitaram IGUAL nos jogos deste lacre — 2 pts de diferença segue intacta');
    expect(all2).toContain('👯 Gêmeos do lacre: Ana e Bruno cravaram exatamente os mesmos placares em todos os jogos');
  });

  it('lanterna aparece com pelotão de 4+ e fundo de tabela real', () => {
    expect(all).toContain('🐢 Lanterna: Dani (0 pts) — todo campeão já foi lanterna um dia');
  });

  it('empate além do pódio aparece como "+N empatados" (pódio não mente)', () => {
    // U5 também fez 0×0 no jogo 3 → 1 pt, empatado com o 3º (Carlos).
    const tied = {
      ...content,
      predictions: [...content.predictions,
        { user_id: U5, match_id: 3, pred_home: 0, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-08T12:00:00Z' }],
    };
    const all3 = buildPicksMessages({ ...base, content: tied }).join('\n');
    expect(all3).toContain('🥉 Carlos 1 pt · +1 empatado com 1 pt');
  });
});

describe('extras do lacre', () => {
  const all = buildPicksMessages(base).join('\n');

  it('promessa de gols: jogo com maior média esperada (formato pt-BR)', () => {
    expect(all).toContain('🚿 Promessa de gols: Canadá × Senegal — a galera espera 3,0 gols de média');
  });

  it('jogo trancado só aparece com média baixa de verdade (≤1,5)', () => {
    expect(all).not.toContain('🧱'); // média mínima da fixture é 2,2
  });

  it('sem gêmeos na fixture base (ninguém com palpites idênticos em tudo)', () => {
    expect(all).not.toContain('👯');
  });

  it('gêmeos em massa (3+ grupos) é norma, não notícia → linha suprimida', () => {
    const U6 = '66666666-aaaa-4bbb-8ccc-666666666666';
    const U7 = '77777777-aaaa-4bbb-8ccc-777777777777';
    const crowded = {
      ...content,
      predictions: [
        ...content.predictions.map((p) => (
          // Bruno copia a Ana nos jogos novos (1º grupo de gêmeos)
          p.user_id === U2 && (p.match_id === 1 || p.match_id === 2)
            ? { ...p, pred_home: p.match_id === 1 ? 2 : 1, pred_away: p.match_id === 1 ? 1 : 0 }
            : p
        )),
        // U6 copia Carlos e U7 copia Dani → 3 grupos no total
        { user_id: U6, match_id: 1, pred_home: 0, pred_away: 0, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
        { user_id: U6, match_id: 2, pred_home: 2, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
        { user_id: U7, match_id: 1, pred_home: 3, pred_away: 1, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
        { user_id: U7, match_id: 2, pred_home: 4, pred_away: 2, pred_pen_winner: null, updated_at: '2026-06-10T12:00:00Z' },
      ],
    };
    expect(buildPicksMessages({ ...base, content: crowded }).join('\n')).not.toContain('👯');
  });

  it('bloco de extras tem cabeçalho próprio', () => {
    expect(all).toContain('🍿 <b>Extras do lacre</b>');
  });
});

describe('higiene — HTML escapado e nada de e-mail', () => {
  it('nome malicioso não injeta HTML na mensagem (linha de aposta solitária e ranking)', () => {
    const evil = {
      ...content,
      users: content.users.map((u) => (u.user_id === U3 ? { ...u, name: '<b>Hacker</b> & Cia' } : u)),
    };
    const all = buildPicksMessages({ ...base, content: evil }).join('\n');
    expect(all).toContain('&lt;b&gt;Hacker&lt;/b&gt; &amp; Cia');
    expect(all).not.toContain('<b>Hacker</b>');
  });

  it('a mensagem só usa dados do content lacrado (sem e-mail por construção)', () => {
    const all = buildPicksMessages(base).join('\n');
    expect(all).not.toMatch(/email|@.*\./i);
  });

  it('cabeçalho identifica o lacre e rodapé linka o relatório publicado', () => {
    const all = buildPicksMessages(base).join('\n');
    expect(all).toContain('Palpites lacrados — lacre #7');
    expect(all).toContain(`<a href="${base.reportUrl}">Palpite por palpite no relatório do lacre #7</a>`);
  });
});

describe('chunking — teto do Telegram', () => {
  it('maxLen apertado divide em várias mensagens, todas dentro do teto e com cabeçalho', () => {
    const msgs = buildPicksMessages({ ...base, prevContent: null, maxLen: 500 });
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(500);
      expect(m).toContain('Palpites lacrados — lacre #7');
    }
    // nenhum bloco se perde na divisão
    const all = msgs.join('\n');
    for (const t of ['México × Polônia', 'Canadá × Senegal', 'França × Brasil', 'Argentina × Chile']) {
      expect(all).toContain(t);
    }
  });

  it('default folgado: tudo numa mensagem só', () => {
    expect(buildPicksMessages(base)).toHaveLength(1);
  });
});
