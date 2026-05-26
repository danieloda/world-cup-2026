#!/usr/bin/env node
/**
 * Fill test results for matches (for E2E testing)
 * Usage: node scripts/fill-test-results.js [--stage group|ko|all] [--limit N]
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY
);

// Parse arguments
const args = process.argv.slice(2);
const stageArg = args.find(a => a.startsWith('--stage='))?.split('=')[1] || 'group';
const limitArg = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || 999;

// Realistic score generator (weighted towards low-scoring games)
function generateScore() {
  const weights = [
    { home: 0, away: 0, weight: 8 },
    { home: 1, away: 0, weight: 15 },
    { home: 0, away: 1, weight: 15 },
    { home: 1, away: 1, weight: 12 },
    { home: 2, away: 0, weight: 10 },
    { home: 0, away: 2, weight: 10 },
    { home: 2, away: 1, weight: 12 },
    { home: 1, away: 2, weight: 12 },
    { home: 2, away: 2, weight: 6 },
    { home: 3, away: 0, weight: 4 },
    { home: 0, away: 3, weight: 4 },
    { home: 3, away: 1, weight: 5 },
    { home: 1, away: 3, weight: 5 },
    { home: 3, away: 2, weight: 3 },
    { home: 2, away: 3, weight: 3 },
    { home: 4, away: 0, weight: 1 },
    { home: 0, away: 4, weight: 1 },
    { home: 4, away: 1, weight: 1 },
    { home: 1, away: 4, weight: 1 },
  ];

  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
  let random = Math.random() * totalWeight;

  for (const w of weights) {
    random -= w.weight;
    if (random <= 0) return { home: w.home, away: w.away };
  }
  return { home: 1, away: 1 };
}

async function main() {
  console.log(`\n🏆 Fill Test Results\n`);
  console.log(`Stage: ${stageArg}, Limit: ${limitArg}\n`);

  // Get unfinished matches
  let query = supabase
    .from('matches')
    .select('*')
    .eq('finished', false)
    .order('match_date')
    .limit(limitArg);

  if (stageArg === 'group') {
    query = query.eq('stage', 'group');
  } else if (stageArg === 'ko') {
    query = query.neq('stage', 'group');
  }

  const { data: matches, error } = await query;

  if (error) {
    console.error('Error fetching matches:', error.message);
    process.exit(1);
  }

  if (!matches || matches.length === 0) {
    console.log('No unfinished matches found for this stage.');
    process.exit(0);
  }

  console.log(`Found ${matches.length} unfinished matches\n`);

  // Get players for scorer attribution
  const { data: players } = await supabase
    .from('players')
    .select('id, full_name, team, position')
    .order('full_name');

  const playersByTeam = {};
  for (const p of (players || [])) {
    if (!playersByTeam[p.team]) playersByTeam[p.team] = [];
    playersByTeam[p.team].push(p);
  }

  let filled = 0;
  let skipped = 0;

  for (const match of matches) {
    const score = generateScore();

    // For knockout matches with a draw, pick a random penalty winner
    const isKO = match.stage !== 'group';
    const isDraw = score.home === score.away;
    const penWinner = (isKO && isDraw) ? (Math.random() > 0.5 ? 'home' : 'away') : null;

    // Update match
    const { error: updateError } = await supabase
      .from('matches')
      .update({
        actual_home: score.home,
        actual_away: score.away,
        pen_winner: penWinner,
        finished: true,
        finished_at: new Date().toISOString(),
      })
      .eq('id', match.id);

    if (updateError) {
      console.log(`❌ ${match.team_home} vs ${match.team_away}: ${updateError.message}`);
      skipped++;
      continue;
    }

    // Add scorers
    const totalGoals = score.home + score.away;
    if (totalGoals > 0) {
      const homePlayers = playersByTeam[match.team_home] || [];
      const awayPlayers = playersByTeam[match.team_away] || [];

      // Distribute goals
      const scorerGoals = [];

      // Home goals
      let homeGoalsLeft = score.home;
      const homeAttackers = homePlayers.filter(p => p.position === 'ATA' || p.position === 'MEI');
      const homePool = homeAttackers.length > 0 ? homeAttackers : homePlayers;
      while (homeGoalsLeft > 0 && homePool.length > 0) {
        const scorer = homePool[Math.floor(Math.random() * homePool.length)];
        const goals = Math.min(homeGoalsLeft, Math.ceil(Math.random() * 2));
        scorerGoals.push({ player_id: scorer.id, match_id: match.id, goals });
        homeGoalsLeft -= goals;
      }

      // Away goals
      let awayGoalsLeft = score.away;
      const awayAttackers = awayPlayers.filter(p => p.position === 'ATA' || p.position === 'MEI');
      const awayPool = awayAttackers.length > 0 ? awayAttackers : awayPlayers;
      while (awayGoalsLeft > 0 && awayPool.length > 0) {
        const scorer = awayPool[Math.floor(Math.random() * awayPool.length)];
        const goals = Math.min(awayGoalsLeft, Math.ceil(Math.random() * 2));
        scorerGoals.push({ player_id: scorer.id, match_id: match.id, goals });
        awayGoalsLeft -= goals;
      }

      // Insert scorers (if we have players)
      if (scorerGoals.length > 0) {
        await supabase.from('player_goals').upsert(scorerGoals, { onConflict: 'player_id,match_id' });
      }
    }

    const penText = penWinner ? ` (pen: ${penWinner})` : '';
    console.log(`✓ ${match.team_home} ${score.home}-${score.away} ${match.team_away}${penText}`);
    filled++;
  }

  console.log(`\n✅ Done! Filled ${filled} matches, skipped ${skipped}\n`);
}

main().catch(console.error);
