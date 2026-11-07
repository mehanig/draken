import { test, expect } from '@playwright/test';

// These checks use the synthetic UI server. No real sessions, credentials, or providers.
test('GifGun signature: square surfaces, shared palette, readable text and keyboard focus', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== 'http://127.0.0.1:41889') externalRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Pick up where you left off.' })).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(199, 198, 192)');
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(17, 17, 17)');
  const card = page.locator('.card').first();
  await expect(card).toHaveCSS('border-radius', '0px');
  await expect(card).toHaveCSS('border-top-width', '2px');
  await expect(card).toHaveCSS('background-color', 'rgb(222, 221, 215)');
  await expect(card).toHaveCSS('box-shadow', 'rgb(145, 54, 216) 8px 8px 0px 0px');
  const primary = page.locator('.btn-primary').first();
  await expect(primary).toHaveCSS('background-color', 'rgb(145, 54, 216)');
  await expect(primary).toHaveCSS('border-radius', '0px');
  await expect(primary).toHaveCSS('text-transform', 'uppercase');
  await expect(page.locator('.brand img')).toHaveAttribute('src', '/favicon.png');

  await page.keyboard.press('Tab');
  const homeLink = page.getByRole('link', { name: 'Draken sync history' });
  await expect(homeLink).toBeFocused();
  await expect(homeLink).toHaveCSS('outline-width', '3px');
  await expect(homeLink).toHaveCSS('outline-style', 'solid');
  await expect(homeLink).toHaveCSS('outline-color', 'rgb(145, 54, 216)');

  // Small supporting text and button/citation labels need normal-text contrast.
  const contrastRatios = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const luminance = (hex: string) => {
      const channels = hex.trim().replace('#', '').match(/.{2}/g)!.map(value => parseInt(value, 16) / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    const color = (value: string) => luminance(value.startsWith('--') ? style.getPropertyValue(value) : value);
    return [['--muted', '--paper'], ['--muted', '--panel'], ['#ffffff', '--accent'], ['--blue', '--panel']]
      .map(([foreground, background]) => {
        const a = color(foreground), b = color(background);
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      });
  });
  for (const ratio of contrastRatios) expect(ratio).toBeGreaterThanOrEqual(4.5);
  await page.getByRole('heading', { name: 'Pick up where you left off.' }).click();
  await page.screenshot({ path: '.test-artifacts/bauhaus-desktop.png', fullPage: true });
  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.screenshot({ path: '.test-artifacts/bauhaus-mobile.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(primary).toHaveCSS('transition-duration', '0s');
  expect(externalRequests).toEqual([]);
});

test('authenticated login uses the same theme, visible focus and readable errors', async ({ page }) => {
  await page.route('**/api/auth/status', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/auth/login', route => route.fulfill({ status: 401, json: { error: 'Invalid credentials' } }));
  await page.goto('/');
  const username = page.getByLabel('Username', { exact: true });
  await expect(username).toBeFocused();
  await expect(username).toHaveCSS('outline-width', '3px');
  await expect(page.locator('.login-card')).toHaveCSS('border-radius', '0px');
  await expect(page.locator('.login-card')).toHaveCSS('box-shadow', 'rgb(145, 54, 216) 10px 10px 0px 0px');
  await username.fill('demo');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-example');
  await page.screenshot({ path: '.test-artifacts/bauhaus-login.png' });
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid credentials');
  await expect(page.getByRole('alert')).toHaveCSS('background-color', 'rgb(251, 224, 220)');
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(page.locator('body')).toHaveCSS('background-image', 'none');
  await expect(page.locator('.login-card')).toHaveCSS('box-shadow', 'none');
});
