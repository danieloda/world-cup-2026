-- ============================================================
-- Bolão Copa 2026 — Clean Test Data
-- ============================================================
-- Run this in Supabase SQL Editor before going to production.
-- Keeps: matches, players, settings, admin user
-- Deletes: predictions, picks, test profiles, match results
--
-- ALSO: Delete test users from Authentication → Users manually
-- ============================================================

-- 1. Delete all predictions
DELETE FROM public.predictions;

-- 2. Delete champion picks
DELETE FROM public.champion_picks;

-- 3. Delete top scorer picks
DELETE FROM public.top_scorer_picks;

-- 4. Delete player goals (admin-entered test data)
DELETE FROM public.player_goals;

-- 5. Reset all matches to unfinished state
UPDATE public.matches SET
  actual_home = NULL,
  actual_away = NULL,
  pen_winner = NULL,
  finished = FALSE,
  finished_at = NULL;

-- 6. Delete test user profiles (keep admin)
DELETE FROM public.profiles WHERE is_admin = FALSE;

-- 7. Verify cleanup
SELECT 'profiles' as table_name, count(*) as count FROM public.profiles
UNION ALL SELECT 'predictions', count(*) FROM public.predictions
UNION ALL SELECT 'champion_picks', count(*) FROM public.champion_picks
UNION ALL SELECT 'top_scorer_picks', count(*) FROM public.top_scorer_picks
UNION ALL SELECT 'player_goals', count(*) FROM public.player_goals
UNION ALL SELECT 'matches', count(*) FROM public.matches
UNION ALL SELECT 'players', count(*) FROM public.players
UNION ALL SELECT 'settings', count(*) FROM public.settings;

-- Expected output:
-- profiles: 1 (admin only)
-- predictions: 0
-- champion_picks: 0
-- top_scorer_picks: 0
-- player_goals: 0
-- matches: 104
-- players: 51
-- settings: 4
