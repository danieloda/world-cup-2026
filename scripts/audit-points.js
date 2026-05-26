#!/usr/bin/env node
// Audita pontuação total: jogos + campeão + artilheiro
// Uso: node scripts/audit-points.js
//      ou: node scripts/audit-points.js --email=daniel.ashton@mainstay.io --password=XXXX

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

// Parse CLI args
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const EMAIL = args.email || process.env.TEST_USER_EMAIL;
const PASSWORD = args.password || process.env.TEST_USER_PASSWORD;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);

// Stage multipliers (deve bater com o script SQL stage_multiplier())
const STAGE_MULT = { group: 1.0, r32: 1.5, r16: 2.0, qf: 2.5, sf: 3.0, third: 2.0, final: 4.0 };

function scorePrediction(ph, pa, ppen, ah, aw, apen, stage) {
  if (ph == null || pa == null || ah == null || aw == null) return 0;
  const mult = STAGE_MULT[stage] ?? 1.0;
  let predW, actW;
  if (ph > pa) predW = 'h';
  else if (pa > ph) predW = 'a';
  else if (stage !== 'group' && ppen) predW = ppen;
  else predW = 'd';
  if (ah > aw) actW = 'h';
  else if (aw > ah) actW = 'a';
  else if (stage !== 'group' && apen) actW = apen;
  else actW = 'd';

  let base = 0;
  if (ph === ah && pa === aw) base = 5;
  else if (predW === actW && (ph - pa) === (ah - aw)) base = 3;
  else if (predW === actW) base = 2;
  else if (ph === ah || pa === aw) base = 1;
  return Math.round(base * mult);
}

async function main() {
  console.log('🔐 Autenticando...');
  const { error: authErr } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (authErr) {
    console.error('❌ Auth falhou:', authErr.message);
    process.exit(1);
  }
  const { data: { user } } = await supabase.auth.getUser();
  console.log(`✓ Logado como ${user.email}\n`);

  // 1. Profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  console.log(`👤 ${profile.full_name} · paid: ${profile.paid}`);

  // 2. v_leaderboard entry
  const { data: lb } = await supabase
    .from('v_leaderboard')
    .select('*')
    .eq('user_id', user.id)
    .single();
  console.log(`\n📊 v_leaderboard (sistema):`);
  console.log(`   match_pts:    ${lb?.match_pts ?? '?'}`);
  console.log(`   champion_pts: ${lb?.champion_pts ?? '?'}`);
  console.log(`   scorer_pts:   ${lb?.scorer_pts ?? '?'}`);
  console.log(`   TOTAL:        ${lb?.total_pts ?? '?'}`);

  // 3. Recalcula match points manualmente
  const { data: matches } = await supabase
    .from('matches')
    .select('*')
    .eq('finished', true)
    .order('id');

  const { data: preds } = await supabase
    .from('predictions')
    .select('*')
    .eq('user_id', user.id);

  const predByMatch = new Map(preds.map(p => [p.match_id, p]));

  const stageTotals = {};
  let totalCalc = 0;
  let totalStored = 0;
  let mismatchCount = 0;
  const mismatches = [];

  for (const m of matches) {
    const p = predByMatch.get(m.id);
    if (!p) continue;
    const calc = scorePrediction(
      p.pred_home, p.pred_away, p.pred_pen_winner,
      m.actual_home, m.actual_away, m.pen_winner,
      m.stage
    );
    const stored = p.points_earned ?? 0;
    if (!stageTotals[m.stage]) stageTotals[m.stage] = { count: 0, calc: 0, stored: 0 };
    stageTotals[m.stage].count++;
    stageTotals[m.stage].calc += calc;
    stageTotals[m.stage].stored += stored;
    totalCalc += calc;
    totalStored += stored;
    if (calc !== stored) {
      mismatchCount++;
      mismatches.push({
        id: m.id, stage: m.stage,
        pred: `${p.pred_home}-${p.pred_away}${p.pred_pen_winner ? '/' + p.pred_pen_winner : ''}`,
        real: `${m.actual_home}-${m.actual_away}${m.pen_winner ? '/' + m.pen_winner : ''}`,
        calc, stored,
      });
    }
  }

  console.log(`\n🎯 Match points por fase (recalc vs armazenado):`);
  const stageOrder = ['group', 'r32', 'r16', 'qf', 'sf', 'third', 'final'];
  for (const s of stageOrder) {
    const st = stageTotals[s];
    if (!st) continue;
    const ok = st.calc === st.stored ? '✓' : '⚠️';
    console.log(`   ${s.padEnd(6)} ×${STAGE_MULT[s]}  ${st.count} jogos  calc=${st.calc}  armaz=${st.stored}  ${ok}`);
  }
  console.log(`   ${'TOTAL'.padEnd(13)}                     calc=${totalCalc}  armaz=${totalStored}  ${totalCalc === totalStored ? '✓' : '⚠️ DIFF'}`);

  if (mismatchCount > 0) {
    console.log(`\n⚠️  ${mismatchCount} jogo(s) com pontos diferentes:`);
    for (const m of mismatches.slice(0, 10)) {
      console.log(`   M${m.id} (${m.stage}): pred=${m.pred} real=${m.real} | calc=${m.calc} armaz=${m.stored}`);
    }
    if (mismatches.length > 10) console.log(`   ... e mais ${mismatches.length - 10}`);
  }

  // 4. Champion check
  const { data: champPick } = await supabase
    .from('champion_picks')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  const { data: finalMatch } = await supabase
    .from('matches')
    .select('*')
    .eq('stage', 'final')
    .maybeSingle();

  let realChampion = null;
  if (finalMatch?.finished) {
    if (finalMatch.actual_home > finalMatch.actual_away) realChampion = finalMatch.team_home;
    else if (finalMatch.actual_away > finalMatch.actual_home) realChampion = finalMatch.team_away;
    else if (finalMatch.pen_winner === 'home') realChampion = finalMatch.team_home;
    else if (finalMatch.pen_winner === 'away') realChampion = finalMatch.team_away;
  }

  const championCalc = champPick && realChampion && champPick.team === realChampion ? 50 : 0;
  console.log(`\n🏆 Campeão:`);
  console.log(`   Palpite:      ${champPick?.team ?? '(nenhum)'}`);
  console.log(`   Real:         ${realChampion ?? '(final não finalizada)'}`);
  console.log(`   Acertou?      ${championCalc === 50 ? '✓ SIM' : '✗ NÃO'}`);
  console.log(`   Bônus calc:   ${championCalc}`);
  console.log(`   Bônus armaz:  ${lb?.champion_pts ?? '?'}  ${championCalc === lb?.champion_pts ? '✓' : '⚠️ DIFF'}`);

  // 5. Top scorer
  const { data: scorerPick } = await supabase
    .from('top_scorer_picks')
    .select('*, players(*)')
    .eq('user_id', user.id)
    .maybeSingle();

  let scorerCalc = 0;
  let totalGoals = 0;
  let gamesWithGoals = 0;
  if (scorerPick) {
    const { data: goals } = await supabase
      .from('player_goals')
      .select('goals, match_id, matches!inner(stage, finished)')
      .eq('player_id', scorerPick.player_id)
      .eq('matches.finished', true);
    for (const g of (goals ?? [])) {
      const mult = STAGE_MULT[g.matches.stage] ?? 1.0;
      scorerCalc += Math.round(g.goals * 2 * mult);
      totalGoals += g.goals;
      gamesWithGoals++;
    }
  }

  console.log(`\n⚽ Artilheiro:`);
  console.log(`   Palpite:      ${scorerPick?.players?.full_name ?? '(nenhum)'} (${scorerPick?.players?.team ?? '-'})`);
  console.log(`   Gols:         ${totalGoals} em ${gamesWithGoals} jogo(s)`);
  console.log(`   Bônus calc:   ${scorerCalc}`);
  console.log(`   Bônus armaz:  ${lb?.scorer_pts ?? '?'}  ${scorerCalc === lb?.scorer_pts ? '✓' : '⚠️ DIFF'}`);

  // 6. Final total
  const expectedTotal = totalCalc + championCalc + scorerCalc;
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`📊 TOTAL FINAL`);
  console.log(`   Calc:   ${totalCalc} (jogos) + ${championCalc} (campeão) + ${scorerCalc} (artilheiro) = ${expectedTotal}`);
  console.log(`   Armaz:  ${lb?.total_pts ?? '?'}`);
  console.log(`   ${expectedTotal === lb?.total_pts ? '✓ MATEMÁTICA OK' : '⚠️  DIFERENÇA DE ' + Math.abs(expectedTotal - (lb?.total_pts ?? 0)) + ' PTS'}`);
  console.log(`═══════════════════════════════════════════════════`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
