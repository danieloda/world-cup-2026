// ============================================================
// Paridade do RANKING: v_leaderboard (SQL, a fonte) × prize.js (JS, a ordem
// exibida). Mesmo espírito de scoring-parity/deadline-parity: parseia a ÚLTIMA
// definição da view nas migrations e trava os pontos onde um lado pode
// divergir do outro sem nenhum teste falhar.
//
// O comportamento do desempate em si é testado em prize.test.js; aqui o alvo
// é o DRIFT entre as duas pontas (critérios, ordem, filtro de pagantes).
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dirname, '..', '..', 'supabase', 'migrations');
const SRC_DIR = join(__dirname, '..', '..', 'src', 'js');

// Última migration que (re)define a view — migrations são append-only, vale a última.
function latestViewDef() {
  const files = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
  let found = null;
  for (const f of files) {
    const sql = readFileSync(join(MIG_DIR, f), 'utf8');
    const m = sql.match(/create (?:or replace )?view public\.v_leaderboard[\s\S]*?;\s*\n\s*grant select on public\.v_leaderboard/);
    if (m) found = { file: f, body: m[0], num: parseInt(f, 10) };
  }
  return found;
}

const view = latestViewDef();
const prizeSrc = readFileSync(join(SRC_DIR, 'prize.js'), 'utf8');
const rankingSrc = readFileSync(join(SRC_DIR, 'pages', 'ranking.js'), 'utf8');

describe('v_leaderboard — última definição nas migrations', () => {
  it('sentinela: a definição vigente é a da migration 074 (atualize ao redefinir a view)', () => {
    // Se uma migration nova redefinir a view, este teste OBRIGA a revisitar a
    // paridade (critérios de desempate, filtro de pagantes, void).
    // 074 redefiniu a view: winner_ok passou a ignorar o pênalti (empate acertado
    // = vencedor/empate ok), pra casar com o ave de score_prediction.
    expect(view).not.toBeNull();
    expect(view.num).toBe(74);
  });

  it('ORDER BY = total_pts → exact_count → winner_sg_count (os 3 critérios do desempate)', () => {
    expect(view.body).toMatch(/order by total_pts desc,\s*exact_count desc,\s*winner_sg_count desc/);
  });

  it('só pagantes entram no ranking', () => {
    expect(view.body).toMatch(/where p\.paid = true/);
  });

  it('jogos anulados (void) ficam fora da conta', () => {
    expect(view.body).toMatch(/m\.status <> 'void'/);
  });

  it('semântica dos critérios: exato = placar cravado; V+S = vencedor E saldo sem cravar', () => {
    expect(view.body).toMatch(/\(p\.pred_home = m\.actual_home and p\.pred_away = m\.actual_away\) as is_exact/);
    expect(view.body).toMatch(/count\(\*\) filter \(where not is_exact and winner_ok and diff_ok\)::int as w_sg_count/);
  });

  it('total = placar + campeão + artilheiro + classificado (as 4 parcelas)', () => {
    const total = view.body.match(/\(coalesce\(pp\.match_pts, 0\)[\s\S]*?\) as total_pts/);
    expect(total).not.toBeNull();
    expect(total[0]).toContain('champion_bonus_for');
    expect(total[0]).toContain('scorer_bonus_for');
    expect(total[0]).toContain('uqp.points');
  });
});

describe('prize.js — espelho JS dos mesmos critérios, na mesma ordem', () => {
  it('sortLeaderboard compara total_pts, depois exact_count, depois winner_sg_count', () => {
    const cmp = prizeSrc.match(/export function sortLeaderboard[\s\S]*?\n\}/)[0];
    const iTotal = cmp.indexOf('total_pts');
    const iExact = cmp.indexOf('exact_count');
    const iWsg = cmp.indexOf('winner_sg_count');
    expect(iTotal).toBeGreaterThan(-1);
    expect(iExact).toBeGreaterThan(iTotal);
    expect(iWsg).toBeGreaterThan(iExact);
  });

  it('a página do ranking ordena pelo módulo puro (não confia na ordem do PostgREST)', () => {
    expect(rankingSrc).toMatch(/import \{[^}]*sortLeaderboard[^}]*\} from '\.\.\/prize\.js'/);
    expect(rankingSrc).toMatch(/sortLeaderboard\(/);
  });
});
