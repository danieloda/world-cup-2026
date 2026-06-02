#!/usr/bin/env node
/**
 * RE-SCORING ao EDITAR um resultado já lançado.
 *
 * O 04-admin-results testa LANÇAR resultados; este testa CORRIGIR um já lançado e
 * garantir que tudo recomputa — o caso real "o admin digitou 2-1 e era 1-1":
 *
 *   A) GRUPO: editar o placar de um jogo finalizado recomputa predictions.points_earned
 *      de quem palpitou (== scorePrediction canônico) e o total em v_leaderboard muda
 *      pelo delta exato. Reverter o placar volta tudo ao original.
 *
 *   B) MATA-MATA: editar o VENCEDOR de um jogo de KO re-resolve o slot do jogo seguinte
 *      (team_home/away do match cujo slot é "W{id}"). Reverter volta o time anterior.
 *
 * Tudo no nível do trigger/DB (on_match_finished) — a UI do admin faz o mesmo UPDATE,
 * já coberta por 04-admin-results / test-admin-ui-penalty. Snapshot/restore por jogo;
 * alert triggers desligados durante a edição (ver memory local-e2e-setup).
 *
 * Uso: source .env.e2e.local && node scripts/e2e/test-rescore-on-edit.js
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';
import { makeAdminClient } from './lib/admin-client.js';
import { scorePrediction } from './lib/scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const CID = 'supabase_db_world-cup-2026';
const C = { r: '\x1b[31m', g: '\x1b[32m', b: '\x1b[34m', d: '\x1b[2m', x: '\x1b[0m', bold: '\x1b[1m' };
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`   ${pass ? C.g + '✓' : C.r + '✗'} ${name}${detail ? C.d + ' — ' + detail : ''}${C.x}`);
};
const psql = (sql) => execFileSync('docker', ['exec', '-i', CID, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
const ALERTS = [['matches', 'trg_z_alert_orphan_predictions'], ['matches', 'trg_z_alert_unresolved_slots'], ['predictions', 'trg_z_alert_pred_overwrite']];
// E2E_KEEP_ALERTS=1 → não desliga triggers (alertas reais chegam ao Telegram, por opção do usuário).
const KEEP_ALERTS = process.env.E2E_KEEP_ALERTS === '1';
const toggleAlerts = (a) => {
  if (KEEP_ALERTS) { console.log(`   ${C.d}(E2E_KEEP_ALERTS=1: triggers de alerta mantidos ${a==='disable'?'LIGADOS':'ligados'})${C.x}`); return; }
  return psql(ALERTS.map(([t, g]) => `alter table public.${t} ${a} trigger ${g};`).join('\n'));
};

// vencedor de um jogo (home/away) considerando pênaltis
const winnerOf = (m) =>
  m.actual_home > m.actual_away ? m.team_home
  : m.actual_away > m.actual_home ? m.team_away
  : m.pen_winner === 'home' ? m.team_home
  : m.pen_winner === 'away' ? m.team_away : null;

async function main() {
  console.log(`${C.b}${C.bold}✏️  Re-scoring ao editar resultado${C.x}`);
  const admin = makeAdminClient();
  toggleAlerts('disable');

  // Editar o placar de um jogo dispara o trigger que APAGA os player_goals (scorers)
  // daquele jogo — e reverter o placar NÃO os recria. Sem restaurar, o jogo fica com
  // scorers faltando (diverge do oráculo no total de gols do artilheiro). Snapshot →
  // restore no finally (delete+insert depois que o placar já voltou ao original).
  const goalBackups = {}; // match_id -> [{player_id, match_id, goals}]
  const snapshotGoals = async (matchId) => {
    const { data } = await admin.from('player_goals').select('player_id, match_id, goals').eq('match_id', matchId);
    goalBackups[matchId] = data || [];
  };
  const restoreGoals = async () => {
    for (const [matchId, rows] of Object.entries(goalBackups)) {
      await admin.from('player_goals').delete().eq('match_id', matchId);
      if (rows.length) await admin.from('player_goals').insert(rows);
    }
  };

  try {
    // ============================================================
    // A) GRUPO — editar placar recomputa pontos + leaderboard
    // ============================================================
    console.log(`\n${C.b}A) Grupo: editar placar recomputa pontos${C.x}`);

    // palpiteiro precisa estar no v_leaderboard (paid) p/ o delta de total_pts valer
    const lbUsers = new Set((await admin.from('v_leaderboard').select('user_id')).data.map(u => u.user_id));
    // jogo de grupo finalizado + palpite de alguém que aparece no leaderboard
    const { data: gm } = await admin.from('matches').select('*').eq('stage', 'group').eq('finished', true).order('id').limit(50);
    let M = null, P = null;
    for (const m of gm) {
      const { data: preds } = await admin.from('predictions').select('*').eq('match_id', m.id);
      const cand = (preds || []).find(p => lbUsers.has(p.user_id));
      if (cand) { M = m; P = cand; break; }
    }
    if (!M) throw new Error('nenhum jogo de grupo finalizado com palpite de user do leaderboard');
    const origHome = M.actual_home, origAway = M.actual_away;
    console.log(`   ${C.d}jogo #${M.id} (${M.team_home} ${origHome}-${origAway} ${M.team_away}), user ${P.user_id.slice(0, 8)} palpitou ${P.pred_home}-${P.pred_away}${C.x}`);

    await snapshotGoals(M.id); // scorers serão apagados pelo trigger ao editar o placar
    const oldPts = P.points_earned ?? 0;
    const lbBefore = (await admin.from('v_leaderboard').select('total_pts').eq('user_id', P.user_id).maybeSingle()).data?.total_pts ?? 0;

    // novo placar: o palpite EXATO do user (vira acerto cheio), ou um placar
    // garantidamente diferente se já era exato.
    let newHome = P.pred_home, newAway = P.pred_away;
    if (newHome === origHome && newAway === origAway) { newHome = origHome + 5; newAway = origAway + 7; }
    const expNew = scorePrediction(P.pred_home, P.pred_away, P.pred_pen_winner, newHome, newAway, null, M.stage);

    await admin.from('matches').update({ actual_home: newHome, actual_away: newAway, finished: true }).eq('id', M.id);
    await new Promise(r => setTimeout(r, 300)); // deixa o trigger assentar
    const reNew = (await admin.from('predictions').select('points_earned').eq('match_id', M.id).eq('user_id', P.user_id).single()).data;
    const lbAfter = (await admin.from('v_leaderboard').select('total_pts').eq('user_id', P.user_id).maybeSingle()).data?.total_pts ?? 0;

    check('points_earned recomputado == scorePrediction canônico', reNew.points_earned === expNew, `db=${reNew.points_earned} calc=${expNew}`);
    check('v_leaderboard muda pelo delta exato', lbAfter - lbBefore === expNew - oldPts, `Δlb=${lbAfter - lbBefore} Δesperado=${expNew - oldPts}`);

    // reverter
    await admin.from('matches').update({ actual_home: origHome, actual_away: origAway, finished: true }).eq('id', M.id);
    await new Promise(r => setTimeout(r, 300));
    const reBack = (await admin.from('predictions').select('points_earned').eq('match_id', M.id).eq('user_id', P.user_id).single()).data;
    const lbBack = (await admin.from('v_leaderboard').select('total_pts').eq('user_id', P.user_id).maybeSingle()).data?.total_pts ?? 0;
    check('reverter placar volta points_earned ao original', reBack.points_earned === oldPts, `db=${reBack.points_earned} orig=${oldPts}`);
    check('reverter placar volta v_leaderboard ao original', lbBack === lbBefore, `db=${lbBack} orig=${lbBefore}`);

    // ============================================================
    // B) MATA-MATA — editar vencedor re-resolve o slot a jusante
    // ============================================================
    console.log(`\n${C.b}B) Mata-mata: editar vencedor re-resolve o slot seguinte${C.x}`);

    // acha um KO finalizado K cujo vencedor alimenta um jogo D (slot "W{K.id}")
    const { data: allKo } = await admin.from('matches').select('*').neq('stage', 'group');
    let K = null, D = null, side = null;
    for (const k of allKo.filter(x => x.finished)) {
      const tag = `W${k.id}`;
      const d = allKo.find(x => x.slot_home === tag || x.slot_away === tag);
      if (d) { K = k; D = d; side = d.slot_home === tag ? 'home' : 'away'; break; }
    }
    if (!K) throw new Error('nenhum KO finalizado que alimente outro jogo');
    await snapshotGoals(K.id); // idem: editar o vencedor apaga os scorers de K
    const kHome = K.actual_home, kAway = K.actual_away, kPen = K.pen_winner;
    const origWinner = winnerOf(K);
    const origDteam = side === 'home' ? D.team_home : D.team_away;
    console.log(`   ${C.d}KO #${K.id} (${K.team_home} ${kHome}-${kAway} ${K.team_away}) venc=${origWinner} → alimenta #${D.id}.${side} (=${origDteam})${C.x}`);
    check('slot a jusante reflete o vencedor atual', origDteam === origWinner, `D.${side}=${origDteam} venc=${origWinner}`);

    // flip do vencedor: placar decisivo pro OUTRO lado (zera pênaltis)
    const newWinnerTeam = origWinner === K.team_home ? K.team_away : K.team_home;
    const flipHome = origWinner === K.team_home ? 0 : 3;
    const flipAway = origWinner === K.team_home ? 3 : 0;
    await admin.from('matches').update({ actual_home: flipHome, actual_away: flipAway, pen_winner: null, finished: true }).eq('id', K.id);
    await new Promise(r => setTimeout(r, 400));
    const Dafter = (await admin.from('matches').select('team_home, team_away').eq('id', D.id).single()).data;
    const newDteam = side === 'home' ? Dafter.team_home : Dafter.team_away;
    check('editar vencedor re-resolve o time do slot seguinte', newDteam === newWinnerTeam, `D.${side}=${newDteam} novoVenc=${newWinnerTeam}`);

    // reverter
    await admin.from('matches').update({ actual_home: kHome, actual_away: kAway, pen_winner: kPen, finished: true }).eq('id', K.id);
    await new Promise(r => setTimeout(r, 400));
    const Dback = (await admin.from('matches').select('team_home, team_away').eq('id', D.id).single()).data;
    const backDteam = side === 'home' ? Dback.team_home : Dback.team_away;
    check('reverter vencedor volta o slot seguinte ao time original', backDteam === origDteam, `D.${side}=${backDteam} orig=${origDteam}`);

  } finally {
    try { await restoreGoals(); console.log(`   ${C.g}✓${C.x} player_goals (scorers) restaurados`); }
    catch (e) { console.log(`   ${C.r}⚠ restaurar scorers falhou: ${e.message}${C.x}`); }
    try { toggleAlerts('enable'); console.log(`   ${C.g}✓${C.x} alert triggers religados`); }
    catch (e) { console.log(`\n   ${C.r}⚠ religar alertas falhou: ${e.message}${C.x}`); }
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${C.b}${C.bold}Resumo: ${results.length - failed.length}/${results.length} OK${C.x}`);
  if (failed.length) { console.log(`${C.r}FALHAS: ${failed.map(f => f.name).join('; ')}${C.x}`); process.exit(1); }
  console.log(`${C.g}${C.bold}🎉 Re-scoring ao editar resultado correto.${C.x}`);
  process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
