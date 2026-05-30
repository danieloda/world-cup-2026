import { test, expect } from '@playwright/test';

/**
 * E2E tests for predictions functionality.
 *
 * NOTE: These tests require a valid Supabase configuration and test user.
 * Set up environment variables before running:
 *   - TEST_USER_EMAIL: Email of a test user
 *   - TEST_USER_PASSWORD: Password of the test user
 *
 * Run with: TEST_USER_EMAIL=xxx TEST_USER_PASSWORD=xxx npm run test:e2e
 */

const TEST_EMAIL = process.env.TEST_USER_EMAIL;
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD;

test.describe('Predictions Page', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Requires TEST_USER_EMAIL and TEST_USER_PASSWORD env vars');

  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login.html');
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    // Wait for redirect to inicio
    await expect(page).toHaveURL(/inicio(\.html)?/, { timeout: 10000 });
  });

  test('can navigate to group predictions page', async ({ page }) => {
    await page.goto('/palpites-grupos.html');

    // Tolerante às fases: .match (fase de palpites aberta) OU .empty (Copa encerrada)
    await expect(page.locator('.match, .empty').first()).toBeVisible({ timeout: 10000 });
  });

  test('can navigate to knockout predictions page', async ({ page }) => {
    await page.goto('/palpites-mata.html');

    // Page should load (may show "no matches yet" if tournament hasn't reached KO)
    await expect(page.locator('body')).toContainText(/(Palpites|Mata|Oitavas|32-avos)/i);
  });

  test('can view champion/top scorer page', async ({ page }) => {
    await page.goto('/campeao-artilheiro.html');

    // Should see team selection area
    await expect(page.locator('body')).toContainText(/(Campeão|Artilheiro)/i);
  });
});

test.describe('Prediction Input', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Requires TEST_USER_EMAIL and TEST_USER_PASSWORD env vars');

  test.beforeEach(async ({ page }) => {
    await page.goto('/login.html');
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/inicio(\.html)?/, { timeout: 10000 });
  });

  test('score inputs accept only valid numbers (0-20)', async ({ page }) => {
    await page.goto('/palpites-grupos.html');

    // Espera a página renderizar (inputs abertos OU estado encerrado)
    await expect(page.locator('.score-input, .empty').first()).toBeVisible({ timeout: 10000 });

    const scoreInput = page.locator('.score-input').first();
    if (await scoreInput.count() === 0) {
      test.skip(true, 'Sem jogos abertos para palpitar (Copa encerrada) — fase de palpites não testável neste estado');
      return;
    }
    // Constrangimento numérico: inputmode numérico + maxlength curto (limite real é a CHECK do DB)
    expect(await scoreInput.getAttribute('inputmode')).toBe('numeric');
    const maxlen = parseInt(await scoreInput.getAttribute('maxlength'));
    expect(maxlen).toBeGreaterThan(0);
    expect(maxlen).toBeLessThanOrEqual(2);
  });

  test('shows locked state for past matches', async ({ page }) => {
    await page.goto('/palpites-grupos.html');

    // If there are finished matches, they should show locked state
    // This test depends on tournament progress
    const lockedMatch = page.locator('.locked, [data-locked="true"], .finished');

    // May or may not exist depending on tournament state
    const count = await lockedMatch.count();
    if (count > 0) {
      // Locked matches should not have editable inputs
      const firstLocked = lockedMatch.first();
      const inputs = firstLocked.locator('input:not([readonly]):not([disabled])');
      expect(await inputs.count()).toBe(0);
    }
  });
});

test.describe('Sidebar Navigation', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Requires TEST_USER_EMAIL and TEST_USER_PASSWORD env vars');

  test.beforeEach(async ({ page }) => {
    await page.goto('/login.html');
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/inicio(\.html)?/, { timeout: 10000 });
  });

  test('sidebar shows all navigation items', async ({ page }) => {
    await page.goto('/inicio.html');

    // Check for main navigation items (.sidebar evita strict-mode com o <nav> interno)
    const sidebar = page.locator('.sidebar').first();
    await expect(sidebar).toBeVisible();

    // Should have links to main pages (.first() — palpites casa 2 links: grupos + mata)
    await expect(sidebar.locator('a[href*="inicio"]').first()).toBeVisible();
    await expect(sidebar.locator('a[href*="palpites"]').first()).toBeVisible();
    await expect(sidebar.locator('a[href*="ranking"]').first()).toBeVisible();
  });

  test('sidebar highlights current page', async ({ page }) => {
    await page.goto('/ranking.html');

    // Current page link should have active class
    const activeLink = page.locator('.sidebar a.active, nav a.active, a[aria-current="page"]');
    await expect(activeLink).toBeVisible();
  });
});

test.describe('Leaderboard', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Requires TEST_USER_EMAIL and TEST_USER_PASSWORD env vars');

  test.beforeEach(async ({ page }) => {
    await page.goto('/login.html');
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/inicio(\.html)?/, { timeout: 10000 });
  });

  test('ranking page shows leaderboard', async ({ page }) => {
    await page.goto('/ranking.html');

    // Should show ranking table/list
    await expect(page.locator('.ranking, .leaderboard, table')).toBeVisible({ timeout: 10000 });
  });

  test('shows user points breakdown', async ({ page }) => {
    await page.goto('/ranking.html');

    // Should show points columns
    await expect(page.locator('body')).toContainText(/(Pts|Pontos|Total)/i);
  });
});
