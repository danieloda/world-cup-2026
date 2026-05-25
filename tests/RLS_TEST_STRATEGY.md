# Database RLS (Row Level Security) Test Strategy

This document outlines the strategy for testing Supabase Row Level Security policies.

## Overview

RLS policies are tested directly against Supabase using the Supabase client with different user contexts. These tests verify that:

1. Users can only access data they're authorized to see
2. Users can only modify their own data
3. Admin-only operations are properly restricted
4. Temporal restrictions (prediction locking) work correctly

## Test Categories

### 1. Profile Access Tests

| Test | Expected Behavior |
|------|-------------------|
| User can read own profile | ✅ SELECT own profile |
| User can read all paid profiles | ✅ SELECT all where paid=true |
| User cannot update is_admin | ❌ UPDATE is_admin fails |
| User cannot update paid status | ❌ UPDATE paid fails |
| User can update own full_name | ✅ UPDATE full_name succeeds |
| Admin can update any profile | ✅ Admin UPDATE succeeds |

### 2. Prediction Access Tests

| Test | Expected Behavior |
|------|-------------------|
| User can read own predictions | ✅ SELECT own predictions |
| User can read others' predictions for finished matches | ✅ SELECT after match finished |
| User cannot read others' predictions before match | ❌ SELECT fails for unfinished |
| User can insert prediction before match | ✅ INSERT before match_date |
| User cannot insert prediction after match starts | ❌ INSERT after match_date fails |
| User can update prediction before match | ✅ UPDATE before match_date |
| User cannot update prediction after match starts | ❌ UPDATE after match_date fails |

### 3. Match Access Tests

| Test | Expected Behavior |
|------|-------------------|
| User can read all matches | ✅ SELECT all matches |
| User cannot insert matches | ❌ INSERT fails |
| User cannot update match results | ❌ UPDATE actual_home/away fails |
| Admin can update match results | ✅ Admin UPDATE succeeds |

### 4. Champion/Scorer Pick Tests

| Test | Expected Behavior |
|------|-------------------|
| User can insert pick before deadline | ✅ INSERT before deadline |
| User cannot insert pick after deadline | ❌ INSERT after deadline fails |
| User can update pick before deadline | ✅ UPDATE before deadline |
| User cannot update pick after deadline | ❌ UPDATE after deadline fails |
| User can read own pick anytime | ✅ SELECT own pick |
| User can read others' picks after deadline | ✅ SELECT after deadline |
| User cannot read others' picks before deadline | ❌ SELECT before deadline fails |

## Manual Test Procedure

Run these tests in the Supabase SQL Editor or via the Supabase client.

### Setup

```sql
-- Create test users (do this in Auth UI or via admin API)
-- User A: Regular user (not admin, not paid)
-- User B: Regular user (paid)
-- Admin: Admin user

-- Get user IDs after creation
SELECT id, email FROM auth.users;
```

### Test 1: Profile Self-Promotion Prevention

```sql
-- As regular user, try to make yourself admin
UPDATE profiles SET is_admin = true WHERE id = auth.uid();
-- Expected: 0 rows updated (policy prevents this)

-- Verify
SELECT is_admin FROM profiles WHERE id = auth.uid();
-- Expected: false
```

### Test 2: Prediction Locking

```sql
-- Find a match that has already started
SELECT id, match_date, team_home, team_away
FROM matches
WHERE match_date <= now()
LIMIT 1;

-- Try to insert/update prediction for that match
INSERT INTO predictions (user_id, match_id, pred_home, pred_away)
VALUES (auth.uid(), <match_id>, 2, 1);
-- Expected: ERROR - violates RLS policy

UPDATE predictions
SET pred_home = 3
WHERE user_id = auth.uid() AND match_id = <match_id>;
-- Expected: 0 rows updated
```

### Test 3: Admin Match Updates

```sql
-- As regular user
UPDATE matches SET actual_home = 2, actual_away = 1 WHERE id = 1;
-- Expected: 0 rows updated

-- As admin user
UPDATE matches SET actual_home = 2, actual_away = 1 WHERE id = 1;
-- Expected: 1 row updated
```

### Test 4: Prediction Visibility

```sql
-- As User A, check if you can see User B's predictions for unfinished matches
SELECT * FROM predictions
WHERE user_id = '<user_b_id>'
  AND match_id IN (SELECT id FROM matches WHERE finished = false);
-- Expected: 0 rows (cannot see unfinished)

-- Check for finished matches
SELECT * FROM predictions
WHERE user_id = '<user_b_id>'
  AND match_id IN (SELECT id FROM matches WHERE finished = true);
-- Expected: Shows User B's predictions
```

## Automated Test Implementation

For automated testing, create a test file that uses the Supabase client:

```javascript
// tests/database/rls.test.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

describe('RLS Policies', () => {
  let userASession, userBSession, adminSession;

  beforeAll(async () => {
    // Sign in as different users
    userASession = await supabase.auth.signInWithPassword({
      email: process.env.TEST_USER_A_EMAIL,
      password: process.env.TEST_USER_A_PASSWORD,
    });
    // ... repeat for other users
  });

  test('user cannot self-promote to admin', async () => {
    const { error } = await supabase
      .from('profiles')
      .update({ is_admin: true })
      .eq('id', userASession.user.id);

    // The update should succeed but is_admin should remain false
    const { data } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', userASession.user.id)
      .single();

    expect(data.is_admin).toBe(false);
  });

  // ... more tests
});
```

## CI Integration

To run RLS tests in CI:

1. Set up a dedicated test Supabase project
2. Create test users with known credentials
3. Store credentials as CI secrets
4. Run tests after migrations are applied

```yaml
# .github/workflows/test.yml
jobs:
  rls-tests:
    runs-on: ubuntu-latest
    env:
      SUPABASE_URL: ${{ secrets.TEST_SUPABASE_URL }}
      SUPABASE_ANON_KEY: ${{ secrets.TEST_SUPABASE_ANON_KEY }}
      TEST_USER_A_EMAIL: ${{ secrets.TEST_USER_A_EMAIL }}
      TEST_USER_A_PASSWORD: ${{ secrets.TEST_USER_A_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run test:rls
```

## Scoring Function Tests

Test the scoring functions directly in SQL:

```sql
-- Test exact score
SELECT score_prediction(2, 1, null, 2, 1, null, 'group');
-- Expected: 5

-- Test winner + diff
SELECT score_prediction(3, 1, null, 2, 0, null, 'group');
-- Expected: 3

-- Test winner only
SELECT score_prediction(3, 0, null, 1, 0, null, 'group');
-- Expected: 2

-- Test one side correct
SELECT score_prediction(2, 0, null, 2, 3, null, 'group');
-- Expected: 1

-- Test miss
SELECT score_prediction(3, 0, null, 0, 2, null, 'group');
-- Expected: 0

-- Test multipliers
SELECT score_prediction(2, 1, null, 2, 1, null, 'final');
-- Expected: 25 (5 × 5.0)

SELECT score_prediction(2, 1, null, 2, 1, null, 'sf');
-- Expected: 20 (5 × 4.0)
```

## Notes

- Always test with a separate Supabase project, never production
- Reset test data between test runs
- Consider using Supabase's local development mode for faster tests
- Document any edge cases discovered during testing
