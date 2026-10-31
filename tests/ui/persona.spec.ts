import { test, expect } from '@playwright/test';

test('standalone 3D persona renders locally, follows actual playback and stops on interruption', async ({ page }) => {
  test.setTimeout(60000);
  const external: string[] = [], api: string[] = [], errors: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).origin !== 'http://127.0.0.1:41889') external.push(request.url());
    if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    (window as any).__micRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { (window as any).__micRequests++; throw Error('Preview must not request a microphone'); };
  });
  await page.goto('/persona.html');
  const stage = page.locator('.dp-stage'), canvas = page.locator('.dp-canvas');
  await expect(stage).toHaveAttribute('data-renderer', 'webgl', { timeout: 20000 });
  await expect(canvas).toHaveAttribute('data-mouth', '0');
  await expect(canvas).toHaveAttribute('data-background', 'blurred');
  const cached = await canvas.getAttribute('data-background-renders');
  await page.waitForTimeout(400); // Several animated foreground frames must reuse the cached room.
  await expect(canvas).toHaveAttribute('data-background-renders', cached!);
  await page.getByRole('button', { name: 'Play speech sample', exact: true }).click();
  await expect(stage).toHaveAttribute('data-mode', 'speaking');
  await expect.poll(async () => Number(await canvas.getAttribute('data-mouth'))).toBeGreaterThan(3);
  await page.getByRole('button', { name: 'Stop sample', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-mouth', '0');
  await page.getByRole('button', { name: 'thinking', exact: true }).click();
  await expect(stage).toHaveAttribute('data-mode', 'thinking');
  await page.getByRole('button', { name: 'Pause animation', exact: true }).click();
  await expect(stage).toHaveAttribute('data-motion', 'off');
  await page.screenshot({ path: '.test-artifacts/persona-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(stage).toHaveAttribute('data-renderer', 'webgl');
  await expect.poll(async () => Number(await canvas.getAttribute('data-background-renders'))).toBeGreaterThan(Number(cached));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.test-artifacts/persona-mobile.png', fullPage: true });
  expect(await page.evaluate(() => (window as any).__micRequests)).toBe(0);
  expect(external).toEqual([]); expect(api).toEqual([]); expect(errors).toEqual([]);
});

test('hardware-quality compositing renders without shader errors and preserves static reduced motion', async ({ page }) => {
  // Exercise the high-quality branch on CI's software GL too; this does not
  // claim verification on a physical hardware GPU.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (parameter: number) {
      return parameter === 37446 ? 'Hardware-profile test' : original.call(this, parameter);
    };
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/persona.html');
  const canvas = page.locator('.dp-canvas');
  await expect(canvas).toHaveAttribute('data-background', 'blurred', { timeout: 20000 });
  await expect(canvas).toHaveAttribute('data-quality', 'full');
  await expect(canvas).toHaveAttribute('data-mouth', '0');
  await page.waitForTimeout(300);
  await expect(canvas).toHaveAttribute('data-background-renders', '1');
  expect(errors).toEqual([]);
});

test('reduced motion renders a static scene and context loss has a recoverable local fallback', async ({ page }) => {
  test.setTimeout(45000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/persona.html');
  const stage = page.locator('.dp-stage');
  await expect(stage).toHaveAttribute('data-renderer', 'webgl', { timeout: 20000 });
  await expect(stage).toHaveAttribute('data-motion', 'off');
  await expect(page.getByRole('button', { name: 'Reduced motion' })).toBeDisabled();
  await page.locator('.dp-canvas').evaluate((canvas: HTMLCanvasElement) => {
    canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext();
  });
  await expect(stage).toHaveAttribute('data-renderer', 'fallback');
  await expect(page.getByText('3D is unavailable. Your audio call is unaffected.')).toBeVisible();
  expect(await page.locator('.dp-poster').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.getByRole('button', { name: 'Retry 3D scene' }).click();
  await expect(stage).toHaveAttribute('data-renderer', 'webgl', { timeout: 20000 });
});
