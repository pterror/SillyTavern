import { test, expect } from '@playwright/test';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// NixOS host: the Playwright-managed Chromium download is missing system libs.
if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function dismissWelcomePopupIfPresent(page) {
    const okButton = page.locator('.popup-button-ok');
    try {
        await okButton.first().waitFor({ state: 'visible', timeout: 5000 });
    } catch {
        return;
    }
    await okButton.first().click();
    await okButton.first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

/**
 * Creates and opens a throwaway character with enough tags that the collapsed preview row has
 * real height.
 * @param {import('@playwright/test').Page} page
 */
async function openCharacterWithTags(page) {
    const name = `TagsDrawerOverlayTest-${Date.now()}`;
    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button_label').click();
    await page.locator('.character_select', { hasText: name }).first().click();
    await page.locator('#tagInput').waitFor({ state: 'visible', timeout: 10000 });

    const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    for (const tag of tags) {
        await page.locator('#tagInput').fill('');
        await page.locator('#tagInput').pressSequentially(tag);
        await page.locator('.ui-autocomplete .ui-menu-item', { hasText: tag }).first().click();
    }
    await page.locator('#tagInput').fill('');
    await page.locator('#tagInput').blur();
    await expect(page.locator('#tags_div_preview .tag')).toHaveCount(tags.length);
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function deleteOpenCharacter(page) {
    await page.locator('#delete_button').click();
    const confirmButton = page.locator('.popup-button-ok');
    await confirmButton.first().waitFor({ state: 'visible', timeout: 5000 });
    await confirmButton.first().click();
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function measure(page) {
    return page.evaluate(() => {
        const top = (/** @type {string} */ selector) => document.querySelector(selector).getBoundingClientRect().top;
        return {
            previewTop: top('#tags_div_preview'),
            panelTop: top('#tags_div > .inline-drawer-content'),
            below: ['#creatorInfoWrapper', '#description_textarea'].map(top),
        };
    });
}

/**
 * Hit-tests the middle of the area where the open panel overlaps #creatorInfoWrapper, with the
 * panel itself taken out of hit-testing, so only the clip on what lies underneath decides.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>} Whether #creatorInfoWrapper is hit there.
 */
async function underlayHitUnderPanel(page) {
    return page.evaluate(() => {
        const panel = /** @type {HTMLElement} */ (document.querySelector('#tags_div > .inline-drawer-content'));
        const under = document.getElementById('creatorInfoWrapper');
        const p = panel.getBoundingClientRect();
        const u = under.getBoundingClientRect();
        const x = (Math.max(p.left, u.left) + Math.min(p.right, u.right)) / 2;
        const y = (Math.max(p.top, u.top) + Math.min(p.bottom, u.bottom)) / 2;
        const layers = [panel, ...panel.querySelectorAll('*')].map(el => /** @type {HTMLElement} */ (el));
        layers.forEach(el => el.style.pointerEvents = 'none');
        const hit = document.elementFromPoint(x, y);
        layers.forEach(el => el.style.pointerEvents = '');
        return under.contains(hit);
    });
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function panelSettled(page) {
    await expect.poll(() => page.evaluate(() => document.querySelector('#tags_div > .inline-drawer-content').getAnimations().length)).toBe(0);
}

test.describe('tags drawer overlay', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => dismissWelcomePopupIfPresent(page));

    test('expanded panel starts at the collapsed row, reflows nothing, and hides what it covers', async ({ page }) => {
        await openCharacterWithTags(page);
        try {
            const collapsed = await measure(page);
            expect(await underlayHitUnderPanel(page)).toBe(true);

            await page.locator('#tags_div .inline-drawer-icon').click();
            await expect(page.locator('#tags_div .inline-drawer-icon')).toHaveClass(/\bup\b/);
            await panelSettled(page);

            const expanded = await measure(page);
            expect(collapsed.previewTop).toBeGreaterThan(0);
            expect(Math.abs(expanded.panelTop - collapsed.previewTop)).toBeLessThan(0.5);
            expect(expanded.below).toEqual(collapsed.below);
            expect(await underlayHitUnderPanel(page)).toBe(false);

            await page.locator('#tags_div .inline-drawer-icon').click();
            await expect(page.locator('#tags_div .inline-drawer-icon')).toHaveClass(/\bdown\b/);
            await panelSettled(page);

            expect((await measure(page)).below).toEqual(collapsed.below);
            expect(await underlayHitUnderPanel(page)).toBe(true);
        } finally {
            await deleteOpenCharacter(page);
        }
    });

    test('the clip on what lies underneath follows the panel through its expand/collapse transition', async ({ page }) => {
        await openCharacterWithTags(page);
        try {
            await page.evaluate(() => {
                document.documentElement.style.setProperty('--animation-duration', '400ms');
                document.documentElement.style.setProperty('--SmartThemeBlurTintColor', 'rgba(23, 30, 33, 0.01)');
            });

            // Per frame: the panel's visible bottom (from its own clip-path) vs the bottom of the
            // hole cut into #creatorInfoWrapper, both in viewport coordinates.
            const sampleTransition = () => page.evaluate(() => new Promise(resolve => {
                const panel = /** @type {HTMLElement} */ (document.querySelector('#tags_div > .inline-drawer-content'));
                const under = document.getElementById('creatorInfoWrapper');
                const samples = [];
                const start = performance.now();
                const step = () => {
                    const p = panel.getBoundingClientRect();
                    const clip = /inset\(([^)]*)\)/.exec(getComputedStyle(panel).clipPath)[1].split(/\s+/);
                    const bottomInset = clip[2] ?? clip[0];
                    const inset = bottomInset.endsWith('%') ? parseFloat(bottomInset) / 100 * p.height : parseFloat(bottomInset);
                    const visibleBottom = p.bottom - inset;
                    const hole = /evenodd,(?:[^,]*,){5}([^,]*),(?:[^,]*,){1}([^,]*),/.exec(under.style.clipPath);
                    const holeBottom = hole ? under.getBoundingClientRect().top + parseFloat(hole[2].trim().split(/\s+/)[1]) : null;
                    const u = under.getBoundingClientRect();
                    samples.push({ expectedHoleBottom: Math.min(visibleBottom, u.bottom), holeBottom, covering: visibleBottom > u.top + 1, visibleBottom });
                    if (performance.now() - start < 600) {
                        requestAnimationFrame(step);
                    } else {
                        resolve(samples);
                    }
                };
                requestAnimationFrame(step);
            }));

            await page.locator('#tags_div .inline-drawer-icon').click();
            const opening = await sampleTransition();
            await page.locator('#tags_div .inline-drawer-icon').click();
            const closing = await sampleTransition();

            for (const samples of [opening, closing]) {
                const covering = samples.filter(s => s.covering);
                // The transition must actually have been sampled mid-way, not just its end states.
                expect(new Set(covering.map(s => Math.round(s.visibleBottom))).size).toBeGreaterThan(2);
                for (const s of covering) {
                    expect(s.holeBottom).not.toBeNull();
                    expect(Math.abs(s.holeBottom - s.expectedHoleBottom)).toBeLessThan(1);
                }
            }
            expect(closing.at(-1).holeBottom).toBeNull();
        } finally {
            await deleteOpenCharacter(page);
        }
    });
});
