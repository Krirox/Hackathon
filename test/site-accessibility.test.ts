import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';

const origin = 'http://127.0.0.1:43260';
const files = new Map<string, { body: Buffer; contentType: string }>();
for (const [path, contentType] of [
  ['index.html', 'text/html'],
  ['styles.css', 'text/css'],
  ['app.js', 'text/javascript'],
  ['graphics.js', 'text/javascript'],
  ['assets/three.min.js', 'text/javascript'],
]) {
  files.set('/' + path, {
    body: await readFile(new URL('../site/' + path, import.meta.url)),
    contentType: contentType!,
  });
}

async function localPage(browser: Browser, options: BrowserContextOptions = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/login')
      return route.fulfill({ contentType: 'text/html', body: '<h1>Local console destination</h1>' });
    const file = files.get(url.pathname === '/' ? '/index.html' : url.pathname);
    if (!file) return route.abort();
    return route.fulfill(file);
  });
  const page = await context.newPage();
  return { context, page };
}

async function keyboardMenu(page: Page) {
  const trigger = page.getByRole('button', { name: 'Open menu', exact: true });
  const menu = page.getByRole('dialog', { name: 'Site menu' });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).not.toBeVisible();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const close = page.getByRole('button', { name: 'Close menu', exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu.getByRole('link', { name: 'Contact', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(menu).not.toBeVisible();
  await expect(page.locator('#statement')).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('body')).not.toHaveClass('menu-open');
}

async function readableContent(page: Page) {
  await expect(page.locator('h1')).toHaveText('Governed release workflow');
  await expect(page.locator('#loader')).toHaveCount(0);
  for (const selector of ['#hero-overlay', '#story-overlay', '#statement h2', '#contact .cta-box']) {
    await expect(page.locator(selector)).toBeVisible();
    await expect(page.locator(selector)).toHaveCSS('opacity', '1');
  }
  const hero = await page.locator('#hero-overlay').boundingBox();
  const story = await page.locator('#story-overlay').boundingBox();
  assert.ok(hero && story && story.y >= hero.y + hero.height - 1);
}

test('FLOW-011 source: governed release copy, proof levels, same-origin CTAs, invite-only', () => {
  const html = files.get('/index.html')!.body.toString();
  const app = files.get('/app.js')!.body.toString();
  assert.match(html, /Governed release workflow/);
  assert.match(html, /not an autonomous company OS/);
  assert.doesNotMatch(html, /live runtime/i);
  assert.doesNotMatch(html, /localhost|127\.0\.0\.1/);
  assert.doesNotMatch(app, /localhost|127\.0\.0\.1/);
  assert.doesNotMatch(html, /target="_blank"/);
  assert.doesNotMatch(html, /sign.?up|create (an? )?(org|account)|get started|new org/i);
  assert.match(html, /proof-tag shipped/);
  assert.match(html, /proof-tag demo/);
  assert.match(html, /proof-tag pilot/);
  assert.match(html, /proof-tag roadmap/);
  assert.match(html, /Pilot targets/);
  assert.match(html, /not guaranteed results/);
  assert.match(html, /not a compliance certification/);
  assert.match(html, /DEMO · NOT LIVE DATA/);
  assert.match(html, /not a hosted subscription product/);
  assert.match(html, /data-console data-console-path="\/login" href="\/login"/);
  assert.match(html, /data-cta="pilot-walkthrough"/);
  assert.match(html, /data-cta="console-signin"/);
  assert.match(html, /data-cta="contact"/);
  assert.match(html, /invite-only/);
  assert.match(html, /bound organization/);
  assert.match(html, /mailto:hello@vital\.company\?subject=Vital%20pilot%20walkthrough/);
  assert.match(html, /<meta name="vital-console-url" content=""/);
});

test('FLOW-026 source: noscript fallback, reduced motion, menu keyboard attributes, CTA markers', () => {
  const html = files.get('/index.html')!.body.toString();
  const app = files.get('/app.js')!.body.toString();
  const css = files.get('/styles.css')!.body.toString();
  const graphics = files.get('/graphics.js')!.body.toString();
  assert.match(html, /<noscript>[\s\S]*Request a pilot walkthrough[\s\S]*Sign in to your console[\s\S]*<\/noscript>/);
  assert.match(html, /<a class="skip-link" href="#top">Skip to content<\/a>/);
  assert.match(html, /<main id="top" tabindex="-1">/);
  assert.match(html, /<script src="app\.js" defer><\/script>/);
  assert.match(html, /<script src="graphics\.js" defer><\/script>/);
  assert.doesNotMatch(html, /id="loader"/);
  assert.match(
    html,
    /id="menu-btn"[^>]*aria-controls="overlay"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*hidden/,
  );
  assert.match(html, /<dialog id="overlay" aria-label="Site menu">/);
  assert.match(html, /id="overlay-close"[^>]*aria-label="Close menu"/);
  assert.match(app, /setAttribute\('aria-expanded', '(true|false)'\)/);
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /close\.focus\(\)/);
  assert.match(app, /trigger\.focus\(\)/);
  assert.match(app, /aria-pressed/);
  assert.match(html, /aria-controls="floating-layer-card" aria-pressed="false" disabled/);
  assert.match(html, /<button class="layer-tab"/);
  assert.doesNotMatch(html, /<div class="layer-tab"|<span class="layer-tab" role="button"/);
  assert.match(html, /data-signin-note/);
  assert.match(css, /\.noscript-note/);
  assert.match(css, /\.signin-note/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /#bg-canvas, \.stage-3d-wrapper \{\s*\n?\s*display: none;/);
  assert.match(graphics, /prefers-reduced-motion: reduce/);
  assert.match(graphics, /try \{\s*\n?\s*setup\(\);\s*\n?\s*\} catch/);
  assert.match(graphics, /\} catch \{\s*\n?\s*const background/);
  assert.doesNotMatch(graphics, /requestAnimationFrame|setInterval|setTimeout/);
  assert.doesNotMatch(app, /requestAnimationFrame|IntersectionObserver/);
});

test(
  'FLOW-011/026 browser: CTA markers reachable, same-origin sign-in, no surprise tabs',
  { timeout: 120000 },
  async () => {
    const browser = await chromium.launch();
    try {
      const { context, page } = await localPage(browser, { viewport: { width: 375, height: 812 } });
      try {
        await page.goto(origin);
        for (const cta of ['pilot-walkthrough', 'console-signin', 'contact']) {
          await expect(page.locator(`[data-cta="${cta}"]`).first()).toBeVisible();
        }
        await expect(page.locator('.hero-actions [data-cta="pilot-walkthrough"]')).toBeInViewport({ ratio: 1 });
        await expect(page.locator('[data-signin-note]').first()).toContainText('invite-only');
        await expect(page.locator('[data-signin-note]').first()).toContainText('bound organization');
        const signins = page.locator('[data-cta="console-signin"]');
        for (let i = 0; i < (await signins.count()); i++) {
          await expect(signins.nth(i)).toHaveAttribute('href', '/login');
          await expect(signins.nth(i)).not.toHaveAttribute('target', '_blank');
        }
        await expect(page.locator('.noscript-note')).toHaveCount(0);
        await page.keyboard.press('Tab');
        await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.locator('#top')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.locator('.hero-actions [data-cta="pilot-walkthrough"]')).toBeFocused();
        await page.locator('.header-nav [data-cta="console-signin"]').click();
        await expect(page).toHaveURL(origin + '/login');
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },
);
test('FLOW-026 source: content is not gated by scripts or animation loops', () => {
  const html = files.get('/index.html')!.body.toString();
  const app = files.get('/app.js')!.body.toString();
  const graphics = files.get('/graphics.js')!.body.toString();
  assert.doesNotMatch(html, /id="loader"/);
  assert.doesNotMatch(app, /THREE|WebGL|getContext|IntersectionObserver|requestAnimationFrame/);
  assert.doesNotMatch(graphics, /requestAnimationFrame|setInterval|setTimeout/);
  assert.match(html, /<script src="app.js" defer><\/script>/);
  assert.match(
    html,
    /data-cta="pilot-walkthrough" href="mailto:hello@vital.company\?subject=Vital%20pilot%20walkthrough"/,
  );
});

test('FLOW-026 browser: progressive enhancement and keyboard/mobile access', { timeout: 120000 }, async (t) => {
  const browser = await chromium.launch();
  try {
    await t.test('JavaScript disabled: readable sections, early CTA, usable console and footer links', async () => {
      for (const width of [320, 375, 414, 768, 1280]) {
        const { context, page } = await localPage(browser, {
          javaScriptEnabled: false,
          viewport: { width, height: 812 },
        });
        try {
          await page.goto(origin);
          await page.keyboard.press('Tab');
          await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(page.locator('#top')).toBeFocused();
          await readableContent(page);
          await expect(page.locator('#menu-btn')).not.toBeVisible();
          await expect(page.locator('#overlay')).not.toBeVisible();
          await expect(page.locator('.layer-tab').first()).toBeDisabled();
          const primary = page.locator('.hero-actions .cta-btn');
          await expect(primary).toBeInViewport({ ratio: 1 });
          const box = await primary.boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.height >= 44);
          await primary.click({ trial: true });
          await page.locator('.foot-nav a[href="#wedge"]').click();
          await expect(page.locator('#wedge h2')).toBeInViewport();
          await page.locator('.header-nav .nav-signin').click();
          await expect(page).toHaveURL(origin + '/login');
        } finally {
          await context.close();
        }
      }
    });

    await t.test('delayed application script: first-paint content and CTA remain accessible', async () => {
      const { context, page } = await localPage(browser, { viewport: { width: 375, height: 812 } });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/app.js', async (route) => {
        await gate;
        await route.fulfill(files.get('/app.js')!);
      });
      try {
        const navigation = page.goto(origin);
        await readableContent(page);
        await expect(page.locator('#menu-btn')).not.toBeVisible();
        await expect(page.locator('.hero-actions .cta-btn')).toBeInViewport({ ratio: 1 });
        await page.locator('.hero-actions .cta-btn').click({ trial: true });
        release();
        await navigation;
        await keyboardMenu(page);
      } finally {
        release();
        await context.close();
      }
    });

    for (const failure of ['missing-three', 'no-webgl', 'context-throws', 'renderer-throws', 'render-throws']) {
      await t.test(failure + ': navigation, console wiring and layer controls survive', async () => {
        const { context, page } = await localPage(browser, { viewport: { width: 1280, height: 900 } });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        try {
          if (failure === 'missing-three') await page.route('**/assets/three.min.js', (route) => route.abort());
          await page.addInitScript(`
            window.IntersectionObserver = undefined;
            if (${JSON.stringify(failure)} === 'no-webgl') HTMLCanvasElement.prototype.getContext = () => null;
            if (${JSON.stringify(failure)} === 'context-throws') HTMLCanvasElement.prototype.getContext = () => { throw new Error('graphics unavailable'); };
          `);
          await page.route('**/graphics.js', async (route) => {
            let prefix = '';
            if (failure === 'renderer-throws')
              prefix =
                "THREE.WebGLRenderer = function () { window.rendererAttempted = true; throw new Error('renderer unavailable'); };";
            if (failure === 'render-throws')
              prefix =
                "const OriginalRenderer = THREE.WebGLRenderer; THREE.WebGLRenderer = function (...args) { const renderer = new OriginalRenderer(...args); renderer.render = () => { window.renderAttempted = true; throw new Error('render failed'); }; return renderer; };";
            await route.fulfill({
              contentType: 'text/javascript',
              body: prefix + files.get('/graphics.js')!.body.toString(),
            });
          });
          await page.route('**/index.html', async (route) =>
            route.fulfill({
              contentType: 'text/html',
              body: files
                .get('/index.html')!
                .body.toString()
                .replace('name="vital-console-url" content=""', `name="vital-console-url" content="${origin}/bound"`),
            }),
          );
          await page.goto(origin + '/index.html');
          await readableContent(page);
          await expect(page.locator('.header-nav .nav-signin')).toHaveAttribute('href', origin + '/bound/login');
          if (failure === 'renderer-throws') assert.equal(await page.evaluate('window.rendererAttempted'), true);
          if (failure === 'render-throws') assert.equal(await page.evaluate('window.renderAttempted'), true);
          await keyboardMenu(page);
          const compute = page.locator('[data-layer="2"]');
          await compute.focus();
          await page.keyboard.press('Enter');
          await expect(compute).toHaveAttribute('aria-pressed', 'true');
          await expect(page.locator('[data-layer="1"]')).toHaveAttribute('aria-pressed', 'false');
          await expect(page.locator('#card-tag')).toHaveText('Cognitive Router');
          await page.locator('[data-layer="3"]').focus();
          await page.keyboard.press('Space');
          await expect(page.locator('#card-tag')).toHaveText('Coordination Surface');
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }

    await t.test('reduced motion and mobile keyboard: no animation, reachable CTAs, responsive menu', async () => {
      for (const width of [320, 375, 414, 768]) {
        const { context, page } = await localPage(browser, {
          reducedMotion: 'reduce',
          viewport: { width, height: 812 },
        });
        try {
          await page.addInitScript(
            `window.graphicsCalls = 0; HTMLCanvasElement.prototype.getContext = () => { window.graphicsCalls++; throw new Error('should not initialize'); };`,
          );
          await page.goto(origin);
          await readableContent(page);
          assert.equal(await page.evaluate('window.graphicsCalls'), 0);
          assert.equal(await page.evaluate('document.getAnimations().length'), 0);
          await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto');
          await expect(page.locator('.hero-actions .cta-btn')).toBeInViewport({ ratio: 1 });
          await page.keyboard.press('Tab');
          await page.keyboard.press('Enter');
          await page.keyboard.press('Tab');
          await expect(page.locator('.hero-actions .cta-btn')).toBeFocused();
          await expect(page.locator('.hero-actions .cta-btn')).toHaveCSS('outline-style', 'solid');
          await keyboardMenu(page);
          assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
          await page.locator('#contact .cta-btn').click({ trial: true });
          const box = await page.locator('#contact .cta-btn').boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= width);
        } finally {
          await context.close();
        }
      }
    });

    await t.test('normal graphics: static, context loss and preference changes do not block interaction', async () => {
      const { context, page } = await localPage(browser, { viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.addInitScript(
          `window.animationCalls = 0; const raf = window.requestAnimationFrame; window.requestAnimationFrame = (...args) => { window.animationCalls++; return raf(...args); };`,
        );
        await page.goto(origin);
        await readableContent(page);
        await expect(page.locator('#canvas-3d-container canvas')).toHaveCount(1);
        assert.equal(await page.evaluate('window.animationCalls'), 0);
        assert.equal(await page.evaluate('document.getAnimations().length'), 0);
        await page.locator('#bg-canvas').dispatchEvent('webglcontextlost');
        await page.locator('#canvas-3d-container canvas').dispatchEvent('webglcontextlost');
        await page.setViewportSize({ width: 1100, height: 800 });
        await keyboardMenu(page);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(page.locator('#stage-3d-wrapper')).not.toBeVisible();
        assert.equal(await page.evaluate('document.getAnimations().length'), 0);
        await expect(page.locator('.hero-actions .cta-btn')).toBeVisible();
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close();
  }
});
