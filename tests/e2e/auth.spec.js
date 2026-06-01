import { test, expect } from '@playwright/test';

test.describe('Authentication Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Clear any existing session
    await page.context().clearCookies();
  });

  test('redirects unauthenticated users to login page', async ({ page }) => {
    await page.goto('/inicio.html');

    // Should redirect to login
    await expect(page).toHaveURL(/\/login(\.html)?$/);
  });

  test('login page renders correctly', async ({ page }) => {
    await page.goto('/login.html');

    // Check for essential elements
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('shows error for invalid credentials', async ({ page }) => {
    await page.goto('/login.html');

    await page.fill('input[type="email"]', 'invalid@example.com');
    await page.fill('input[type="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');

    // Should show error message — login.js usa #errorBox (class .login-error)
    await expect(page.locator('#errorBox, .error, .toast, [role="alert"]')).toBeVisible({ timeout: 5000 });
  });

  test('login form validates email format', async ({ page }) => {
    await page.goto('/login.html');

    const emailInput = page.locator('input[type="email"]');
    await emailInput.fill('not-an-email');
    await page.click('button[type="submit"]');

    // HTML5 validation should prevent submission
    const validationMessage = await emailInput.evaluate(el => el.validationMessage);
    expect(validationMessage).toBeTruthy();
  });

  test('password field masks input', async ({ page }) => {
    await page.goto('/login.html');

    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).toHaveAttribute('type', 'password');
  });
});

test.describe('Protected Routes', () => {
  // grupos.html / terceiros.html foram fundidas em palpites-grupos.html (agora redirects).
  const protectedPages = [
    '/inicio.html',
    '/palpites-grupos.html',
    '/palpites-mata.html',
    '/campeao-artilheiro.html',
    '/ranking.html',
    '/historico.html',
  ];

  for (const page of protectedPages) {
    test(`${page} requires authentication`, async ({ page: browserPage }) => {
      await browserPage.goto(page);

      // Should redirect to login
      await expect(browserPage).toHaveURL(/\/login(\.html)?$/);
    });
  }
});

test.describe('Admin Access', () => {
  test('admin page requires authentication', async ({ page }) => {
    await page.goto('/admin.html');

    // Should redirect to login
    await expect(page).toHaveURL(/\/login(\.html)?$/);
  });
});
