import { test, expect } from '@playwright/test';

const factoryPage = { proposals: [], nextCursor: null, unavailable: 0, learning: 'enabled', failedExtractions: 0 };

test('desktop navigation includes Factory and marks the current page', async ({ page }) => {
  await page.route('**/api/factory', route => route.fulfill({ json: factoryPage }));
  await page.goto('/settings');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeHidden();
  await expect(nav.getByRole('link')).toHaveText(['Search history', 'Factory', 'Settings']);
  await nav.getByRole('link', { name: 'Factory', exact: true }).click();
  await expect(page).toHaveURL(/\/factory$/);
  await expect(nav.getByRole('link', { name: 'Factory', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
});

for (const width of [320, 390, 760]) test(`mobile navigation opens, dismisses and follows links at ${width}px`, async ({ page }) => {
  const mutations: string[] = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) mutations.push(request.url()); });
  await page.route('**/api/factory', route => route.fulfill({ json: factoryPage }));
  await page.setViewportSize({ width, height: 900 }); await page.goto('/factory');
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(menu).toHaveAttribute('aria-expanded', 'false'); await expect(nav).toBeHidden();
  await menu.focus(); await page.keyboard.press('Enter');
  await expect(nav).toBeVisible(); await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab'); await expect(nav.getByRole('link', { name: 'Search history' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(nav).toBeHidden(); await expect(menu).toBeFocused();
  await menu.click(); await page.getByRole('heading', { name: 'Factory', exact: true }).click(); await expect(nav).toBeHidden();
  await menu.click(); await nav.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/); await expect(nav).toBeHidden();
  await menu.click(); await page.goBack(); await expect(page).toHaveURL(/\/factory$/); await expect(nav).toBeHidden();
  await menu.click(); await expect(nav.getByRole('link', { name: 'Factory' })).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 }); await expect(nav).toBeVisible(); await expect(menu).toBeHidden();
  await expect(page.locator('.header-menu-button')).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width, height: 900 }); await expect(nav).toBeHidden();
  expect(mutations).toEqual([]);
});
