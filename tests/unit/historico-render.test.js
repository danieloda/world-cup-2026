// @vitest-environment jsdom
//
// Exercita o CAMINHO DE RENDER AUTENTICADO de src/js/pages/historico.js — o
// módulo roda renderPage() na avaliação (top-level await). Mocka auth/supabase/
// sidebar com dados mínimos e confirma que um card finalizado renderiza os tiers
// sem crashar. Regressão do crash TDZ: TIER_ICON era const declarado DEPOIS do
// render de topo → "Cannot access 'TIER_ICON' before initialization".
import { describe, it, expect, vi } from 'vitest';

const fx = vi.hoisted(() => ({
  reportFatal: vi.fn(),
  startAutoRefresh: vi.fn(),
  stats: { finished_matches: 1, total_matches: 104, pct_played: 1, paid_users: 5 },
  match: {
    id: 1, match_date: '2026-06-15T19:00:00.000Z', stage: 'group', group_name: 'C',
    finished: true, actual_home: 3, actual_away: 1, pen_winner: null,
    team_home: 'Brazil', team_away: 'Croatia',
  },
  preds: [
    { user_id: 'me', match_id: 1, pred_home: 3, pred_away: 1, pred_pen_winner: null, points_earned: 7, profiles: { full_name: 'Você Teste', paid: true, avatar_url: null } },
    { user_id: 'u2', match_id: 1, pred_home: 2, pred_away: 1, points_earned: 4, profiles: { full_name: 'Ana Braga', paid: true, avatar_url: null } },
    { user_id: 'u3', match_id: 1, pred_home: 0, pred_away: 0, points_earned: 0, profiles: { full_name: 'Zé Silva', paid: true, avatar_url: null } },
  ],
  goals: [{ match_id: 1, player_id: 10, goals: 2, players: { full_name: 'Vini', team: 'Brazil' } }],
  scorers: [{ user_id: 'me', player_id: 10, players: { full_name: 'Vini', team: 'Brazil' } }],
  leaderboard: [
    { user_id: 'me', total_pts: 30, exact_count: 2, winner_sg_count: 1 }, // 1º
    { user_id: 'u2', total_pts: 20, exact_count: 1, winner_sg_count: 1 }, // 2º
    { user_id: 'u3', total_pts: 10, exact_count: 0, winner_sg_count: 0 }, // 3º
  ],
}));

vi.mock('../../src/js/auth.js', () => ({
  requireAuth: async () => ({ profile: { id: 'me', full_name: 'Você Teste' } }),
}));
vi.mock('../../src/js/error-reporter.js', () => ({
  reportFatal: fx.reportFatal,
  isNetworkError: (e) => /failed to fetch|load failed|networkerror/i.test(e?.message || ''),
}));
vi.mock('../../src/js/auto-refresh.js', () => ({ startAutoRefresh: fx.startAutoRefresh }));
vi.mock('../../src/js/sidebar.js', () => ({
  renderShell: async () => {
    const d = document.createElement('div');
    d.id = 'pageBody';
    document.body.appendChild(d);
    return d;
  },
}));
vi.mock('../../src/js/supabase.js', () => {
  const RESULTS = {
    v_pool_stats: { data: fx.stats, error: null },
    v_revealed_matches: { data: [fx.match], error: null },
    player_goals: { data: fx.goals, error: null },
    top_scorer_picks: { data: fx.scorers, error: null },
    predictions: { data: fx.preds, error: null },
    v_leaderboard: { data: fx.leaderboard, error: null },
  };
  const makeQ = (result) => {
    const q = {
      select: () => q, order: () => q, in: () => q, eq: () => q,
      single: () => Promise.resolve(result),
      then: (res, rej) => Promise.resolve(result).then(res, rej),
    };
    return q;
  };
  return {
    supabase: { from: (t) => makeQ(RESULTS[t] ?? { data: [], error: null }) },
    fetchAllPages: async () => fx.preds,
  };
});

describe('historico — render autenticado (regressão TDZ)', () => {
  it('renderiza card finalizado com tiers, sem crashar', async () => {
    await import('../../src/js/pages/historico.js');
    await new Promise(r => setTimeout(r, 0)); // assenta microtasks do top-level await

    expect(fx.reportFatal).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toMatch(/ReferenceError|Cannot access|⚠️ Erro/);

    const pb = document.getElementById('pageBody');
    expect(pb).toBeTruthy();
    const html = pb.innerHTML;
    expect(html).toContain('class="tier');          // Raio-X montou
    expect(html).toContain('Cravaram o placar');     // tier exato (você cravou 3–1)
    expect(html).toContain('Acerto parcial');        // tier parcial com rótulo NEUTRO
    expect(html).toContain('Raio-X');                // cabeçalho do card
    expect(html).toContain('class="board"');         // placar/momento
    expect(html).toContain('rcard r-exact');         // borda pela cor do SEU resultado
    // posições do ranking ao lado dos nomes (pódio com medalha)
    expect(html).toContain('class="pos p1"');         // você = 1º → ouro
    expect(html).toContain('class="pos p2"');         // 2º → prata
    expect(html).toContain('1º');
    // rótulos enganosos do modelo aditivo não voltam
    expect(html).not.toContain('Acertaram o empate');
    expect(html).not.toContain('acertou o vencedor');
  });
});
