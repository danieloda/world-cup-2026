#!/usr/bin/env node
/**
 * E2E script to fill match results through the admin UI
 * Usage: node scripts/fill-matches-e2e.js [--limit=N]
 */

import { chromium } from '@playwright/test';
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.ADMIN_EMAIL || process.env['ADMIN-EMAIL'] || process.env.TEST_USER_EMAIL;
const TEST_PASSWORD = process.env.ADMIN_PASSWORD || process.env['ADMIN-PASSWORD'] || process.env.TEST_USER_PASSWORD;

const args = process.argv.slice(2);
const limitArg = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || 5;

// Generate realistic score
function generateScore() {
  const scores = [
    [0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2],
    [2, 1], [1, 2], [2, 2], [3, 0], [0, 3], [3, 1],
    [1, 3], [3, 2], [2, 3], [4, 1], [1, 4],
  ];
  return scores[Math.floor(Math.random() * scores.length)];
}

// Helper to clear all scorers for a match
async function clearScorers(page, matchId) {
  // Keep clicking remove buttons until there are none left
  let attempts = 0;
  while (attempts < 20) {
    attempts++;
    const removeBtn = await page.$(`.result-row[data-match-id="${matchId}"] [data-action="remove-goal"]`);
    if (!removeBtn) break;

    // Handle the confirm dialog
    page.once('dialog', dialog => dialog.accept());
    await page.click(`.result-row[data-match-id="${matchId}"] [data-action="remove-goal"]`);
    await page.waitForTimeout(500);
  }
}

async function main() {
  console.log('\n🏆 Fill Matches E2E\n');
  console.log(`URL: ${BASE_URL}`);
  console.log(`Limit: ${limitArg} matches\n`);

  if (!TEST_EMAIL || !TEST_PASSWORD) {
    console.error('❌ Set TEST_USER_EMAIL and TEST_USER_PASSWORD in .env');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false, // Show browser so user can watch
    slowMo: 100,     // Slow down for visibility
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Login
    console.log('📝 Logging in...');
    await page.goto(`${BASE_URL}/login.html`);
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    // Wait for redirect to inicio (handles both /inicio and /inicio.html)
    await page.waitForURL(/inicio/, { timeout: 10000 });
    console.log('✓ Logged in\n');

    // Go to admin
    console.log('📊 Opening admin panel...');
    await page.goto(`${BASE_URL}/admin.html`);
    await page.waitForSelector('.admin-tabs', { timeout: 10000 });

    // Click Results tab
    await page.click('[data-tab="results"]');
    await page.waitForSelector('.result-row', { timeout: 10000 });
    console.log('✓ Admin results tab loaded\n');

    // Find unfinished matches
    let filled = 0;
    let skipped = 0;
    let lastSkippedId = null;
    let reloadCounter = 0;

    while (filled < limitArg) {
      // Reload page every 4 matches to pick up resolved slots from trigger
      if (reloadCounter >= 4) {
        console.log('\n🔄 Reloading page to refresh slot resolutions...');
        await page.reload();
        await page.waitForSelector('.result-row', { timeout: 10000 });
        reloadCounter = 0;
        await page.waitForTimeout(1000);
      }
      // Get first pending match (not done) - always re-query to avoid stale references
      const pendingRows = await page.$$('.result-row:not(.done)');

      if (pendingRows.length === 0) {
        console.log('No more pending matches found.');
        break;
      }

      const pendingRow = pendingRows[0];

      // Get match info
      const matchId = await pendingRow.getAttribute('data-match-id');
      const teams = await pendingRow.$$eval('.team-disp', els =>
        els.map(el => el.textContent.trim())
      );

      console.log(`\n🎮 Match ${matchId}: ${teams[0]} vs ${teams[1]}`);

      // Skip matches with unresolved slots (e.g., "W89", "3A/B/C", "1A", "2B")
      const hasUnresolvedSlot = (name) =>
        /^[0-9WL]/.test(name) || name.includes('/');

      if (hasUnresolvedSlot(teams[0]) || hasUnresolvedSlot(teams[1])) {
        console.log('   ⏭ Skipping - teams not yet resolved');

        // Detect if we're stuck on the same match
        if (lastSkippedId === matchId) {
          skipped++;
          if (skipped >= 3) {
            console.log('\n⚠ All remaining matches have unresolved slots. Stopping.');
            break;
          }
        } else {
          lastSkippedId = matchId;
          skipped = 1;
        }

        await page.waitForTimeout(300);
        continue;
      }

      // Reset skip counter when we find a fillable match
      skipped = 0;
      lastSkippedId = null;

      // Check if this is a knockout match (has penalty buttons)
      const isKnockout = await page.$(`.result-row[data-match-id="${matchId}"] .pen-toggle`) !== null;

      // Generate random score
      let [homeScore, awayScore] = generateScore();

      // For knockout matches with a draw, we need to set penalty winner
      const isDraw = homeScore === awayScore;

      console.log(`   Score: ${homeScore} - ${awayScore}${isKnockout && isDraw ? ' (pênaltis)' : ''}`);

      // Fill in scores using page selectors (more stable)
      await page.fill(`#rh_${matchId}`, String(homeScore));
      await page.fill(`#ra_${matchId}`, String(awayScore));

      // If knockout draw, set random penalty winner
      if (isKnockout && isDraw) {
        await page.waitForTimeout(300);
        const penSide = Math.random() > 0.5 ? 'home' : 'away';
        const penBtnSelector = `.result-row[data-match-id="${matchId}"] [data-action="set-pen"][data-side="${penSide}"]`;
        await page.click(penBtnSelector);
        console.log(`   Pênaltis: ${penSide === 'home' ? teams[0] : teams[1]}`);
        await page.waitForTimeout(300);
      }

      // Wait for scorers section to appear
      await page.waitForTimeout(800);

      // Clear any existing scorers from previous attempts (now that section is visible)
      await clearScorers(page, matchId);

      const totalGoals = homeScore + awayScore;

      if (totalGoals > 0) {
        // Click load players button if visible (use page selector)
        const loadBtnSelector = `.result-row[data-match-id="${matchId}"] [data-action="load-players"]`;
        const loadBtn = await page.$(loadBtnSelector);
        if (loadBtn) {
          console.log('   Loading players...');
          await page.click(loadBtnSelector);
          await page.waitForTimeout(2000); // Wait for players to load
        }

        // Helper function to add goals for a specific team
        // teamIndex: 0 = home (🏠), 1 = away (✈️)
        async function addGoalsForTeam(teamName, teamIndex, goalsNeeded) {
          let goalsAdded = 0;
          let attempts = 0;

          while (goalsAdded < goalsNeeded && attempts < 10) {
            attempts++;

            const selectSelector = `#addPlayer_${matchId}`;
            const selectExists = await page.$(selectSelector);
            if (!selectExists) {
              console.log(`   No player select found for ${teamName}`);
              break;
            }

            // Get options with their optgroup info
            // Options are in optgroups: 🏠 Team (N) or ✈️ Team (N)
            const options = await page.$$eval(`${selectSelector} option`, opts =>
              opts.map(o => {
                const optgroup = o.closest('optgroup');
                const groupLabel = optgroup ? optgroup.label : '';
                const isHome = groupLabel.includes('🏠');
                const isAway = groupLabel.includes('✈️');
                return {
                  value: o.value,
                  text: o.textContent,
                  isHome,
                  isAway
                };
              })
            );

            // Find players from the correct team (home or away)
            const teamPlayers = options.filter(o =>
              o.value && (teamIndex === 0 ? o.isHome : o.isAway)
            );

            if (teamPlayers.length === 0) {
              console.log(`   No players available for ${teamName}`);
              break;
            }

            const randomPlayer = teamPlayers[Math.floor(Math.random() * teamPlayers.length)];
            await page.selectOption(selectSelector, randomPlayer.value);

            // Set goals (1 or 2, but not more than needed)
            const goalsToAdd = Math.min(goalsNeeded - goalsAdded, Math.ceil(Math.random() * 2));
            await page.fill(`#addQty_${matchId}`, String(goalsToAdd));

            // Click add
            const addBtnSelector = `.result-row[data-match-id="${matchId}"] [data-action="add-scorer"]`;
            const addBtn = await page.$(addBtnSelector);
            if (addBtn) {
              await page.click(addBtnSelector);
              await page.waitForTimeout(800);
              goalsAdded += goalsToAdd;
              const playerName = randomPlayer.text.split('(')[0].trim();
              console.log(`   Added ${goalsToAdd} goal(s) by ${playerName} (${teamName})`);
            } else {
              break;
            }
          }
          return goalsAdded;
        }

        // Add home team goals first (teamIndex=0)
        if (homeScore > 0) {
          const homeAdded = await addGoalsForTeam(teams[0], 0, homeScore);
          if (homeAdded < homeScore) {
            console.log(`   ⚠ Could only add ${homeAdded}/${homeScore} home goals`);
          }
        }

        // Then add away team goals (teamIndex=1)
        if (awayScore > 0) {
          const awayAdded = await addGoalsForTeam(teams[1], 1, awayScore);
          if (awayAdded < awayScore) {
            console.log(`   ⚠ Could only add ${awayAdded}/${awayScore} away goals`);
          }
        }
      }

      // Click save
      const saveBtnSelector = `.result-row[data-match-id="${matchId}"] [data-action="save-result"]:not([disabled])`;
      const saveBtn = await page.$(saveBtnSelector);
      if (saveBtn) {
        await page.click(saveBtnSelector);
        await page.waitForTimeout(1500);

        // Verify the save worked by checking if row has "done" class
        const rowAfter = await page.$(`.result-row[data-match-id="${matchId}"].done`);
        if (rowAfter) {
          console.log('   ✓ Saved!');
          filled++;
          reloadCounter++;
        } else {
          console.log('   ⚠ Save failed, clearing scorers and inputs...');
          // Remove all scorers before trying again
          await clearScorers(page, matchId);
          await page.fill(`#rh_${matchId}`, '');
          await page.fill(`#ra_${matchId}`, '');
          await page.waitForTimeout(500);
        }
      } else {
        console.log('   ⚠ Save button disabled, clearing scorers and inputs...');
        // Remove all scorers before trying again
        await clearScorers(page, matchId);
        await page.fill(`#rh_${matchId}`, '');
        await page.fill(`#ra_${matchId}`, '');
        await page.waitForTimeout(500);
      }
    }

    console.log(`\n✅ Done! Filled ${filled} matches\n`);
    console.log('Browser will stay open for 30 seconds...');
    await page.waitForTimeout(30000);

  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: 'error-screenshot.png' });
    console.log('Screenshot saved to error-screenshot.png');
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
