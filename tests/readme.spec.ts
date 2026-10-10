import { test, expect } from '@playwright/test';

/**
 * Tests the local README preview (readme-preview.html) served over http.
 * Run:  npx serve . -l 4173   then   npx playwright test
 * (playwright.config.ts webServer block starts it automatically.)
 *
 * Note: banner/snake assets are preview substitutions — the real
 * raw.githubusercontent.com URLs only exist once pushed.
 */
const BASE = 'http://localhost:4173/readme-preview.html';

/**
 * True once the banner's SYSTEM.INFO rows and portrait are fully shown
 * (>4.5s after the svg file finishes loading). The svg-document clock starts
 * when `responseEnd` fires for dark.svg at nav and light.svg after the toggle.
 */
const bannerTypedWindow = () => {
  const img = [...document.querySelectorAll('article img')]
    .find(i => i.alt && i.alt.includes('profile.sh'));
  if (!img || !img.currentSrc) return false;
  const entry = performance.getEntriesByName(img.currentSrc).pop();
  if (!entry) return false;
  return (performance.now() - entry.responseEnd) > 4500;
};
/**
 * True once every external card image has been fully loaded for >2.5s —
 * their internal CSS/SMIL intro animations (streak fadein ends ~1.4s) are
 * then guaranteed finished. `img.complete` alone is unreliable: it stays
 * true for a beat after a theme swap replaces currentSrc.
 */
const cardsSettled = () => [...document.querySelectorAll('article img')]
  .every(img => {
    if (!(img.complete && img.naturalWidth > 0)) return false;
    const entry = performance.getEntriesByName(img.currentSrc).pop();
    return !entry || (performance.now() - entry.responseEnd) > 2500;
  });

/**
 * Full-page shot that survives <img>-embedded animated SVGs. Neither
 * `fullPage:true` nor a bare viewport resize is reliable: Chromium
 * rasterizes off-screen tiles lazily, and an svg doc's CSS-animation
 * clock (the streak card's fadein) restarts with that late raster — the
 * capture then shows the card's first frame. Scrolling forces every row
 * to raster NOW, while the animations have already finished.
 */
async function fullPageShot(page, path) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async () => {
    for (let y = 0; y <= document.documentElement.scrollHeight; y += 450) {
      window.scrollTo(0, y);
      const { promise, resolve } = Promise.withResolvers();
      setTimeout(resolve, 60);
      await promise;
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
  await page.setViewportSize({ width: 1280, height: Math.min(height, 4000) });
  await page.screenshot({ path });
}

test.describe('README preview — terminal style', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('#readme-content > *').first()).toBeVisible({ timeout: 15000 });
  });

  test('renders the README into github-style article', async ({ page }) => {
    await expect(page.locator('article.markdown-body')).toBeVisible();
  });

  test('hero banner shows dark.svg in dark mode', async ({ page }) => {
    const banner = page.locator('article img[alt*="profile.sh"]');
    await expect(banner).toBeVisible({ timeout: 15000 });
    // img.src is the <picture> fallback; the active source is currentSrc
    const url = await banner.evaluate((img: HTMLImageElement) => img.currentSrc);
    expect(url).toContain('dark.svg');
    await expect(banner).toHaveJSProperty('naturalWidth', 1180);
  });
  test('theme toggle switches hero to light.svg', async ({ page }) => {
    await page.locator('#themeSeg button[data-theme="light"]').click();
    const banner = page.locator('article img[alt*="profile.sh"]');
    // wait for the <picture> source switch to propagate
    await expect.poll(() =>
      banner.evaluate((img: HTMLImageElement) => img.currentSrc)
    ).toContain('light.svg');
    await expect(banner).toHaveJSProperty('naturalWidth', 1180);
  });

  test('streak card loads', async ({ page }) => {
    const streak = page.locator('img[src*="streak-stats.demolab.com"]');
    await expect(streak).toBeVisible({ timeout: 20000 });
    // actually decoded, not just laid out — the upstream is slow
    await expect.poll(() =>
      streak.evaluate((img: HTMLImageElement) => img.naturalWidth)
    ).toBeGreaterThan(0);
  });

  test('github stats and top-langs cards load', async ({ page }) => {
    const stats = page.locator('img[src*="github-readme-stats"]');
    await expect(stats).toHaveCount(2);
    await expect(stats.first()).toBeVisible({ timeout: 20000 });
  });

  test('contribution snake renders (demo asset in preview)', async ({ page }) => {
    const snake = page.locator('img[alt*="snake"]');
    await expect(snake).toBeVisible({ timeout: 20000 });
    const src = await snake.getAttribute('src');
    expect(src).toContain('github-contribution-grid-snake');
  });

  test('social badges and links are present', async ({ page }) => {
    await expect(page.locator('a[href*="linkedin.com/in/duylinh15723"]')).toBeVisible();
    await expect(page.locator('a[href*="g.dev/linhdangdev"]')).toBeVisible();
    await expect(page.locator('a[href*="t.me/linhdangdev15723"]')).toBeVisible();
    await expect(page.locator('a[href="mailto:duylinh05030723@gmail.com"]')).toBeVisible();
  });

  test('no projects section', async ({ page }) => {
    const content = await page.locator('article.markdown-body').textContent();
    expect(content).not.toContain('featured_projects');
    expect(content).not.toContain('Music_Streaming');
    expect(content).not.toContain('Exam-Management');
  });

  test('screenshot — dark', async ({ page }) => {
    // images decoded AND intro animations finished (streak card fades in
    // over ~1.4s — shooting earlier captures only its divider strokes)
    await page.waitForFunction(cardsSettled, undefined, { timeout: 30000 });
    // shoot while the banner transcript is fully typed
    await page.waitForFunction(bannerTypedWindow, undefined,
      { polling: 150, timeout: 45000 });
    await fullPageShot(page, 'tests/screenshots/readme-dark.png');
  });

  test('screenshot — light', async ({ page }) => {
    await page.locator('#themeSeg button[data-theme="light"]').click();
    // wait for the swapped-in light banner + any re-fetched cards to settle
    await page.waitForFunction(cardsSettled, undefined, { timeout: 30000 });
    // same fully-typed window; light.svg's clock starts at its own load
    await page.waitForFunction(bannerTypedWindow, undefined,
      { polling: 150, timeout: 45000 });
    await fullPageShot(page, 'tests/screenshots/readme-light.png');
  });
});
