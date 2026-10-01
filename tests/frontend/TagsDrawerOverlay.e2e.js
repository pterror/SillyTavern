import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, setStackedDrawers } from './frontent-test-utils.js';

// NixOS host: the Playwright-managed Chromium download is missing system libs.
if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
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
    // #tagInput counts as visible even in a closed panel, so wait for the selection itself: typing sooner is undone
    // when the form is filled with the selected character.
    await page.waitForFunction(n => window['SillyTavern'].getContext().name2 === n, name);
    await expect(page.locator('#char-info-panel')).toHaveClass(/openDrawer/);
    await page.locator('#tagInput').waitFor({ state: 'visible', timeout: 10000 });

    const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    for (const tag of tags) {
        await page.locator('#tagInput').fill('');
        await page.locator('#tagInput').pressSequentially(tag);
        // Exact text: once an earlier test made these tags, 'eta' also suggests 'theta'.
        await page.locator('.ui-autocomplete .ui-menu-item', { hasText: new RegExp(`^\\s*${tag}\\s*$`) }).first().click();
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
    test.beforeEach(async ({ page }) => setStackedDrawers(page, true));

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

test.describe('tags drawer overlay, stacked drawers off', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => setStackedDrawers(page, false));

    test('the expanded panel clips nothing under it until stacked drawers is turned on, and again once it is off', async ({ page }) => {
        await openCharacterWithTags(page);
        try {
            await page.locator('#tags_div .inline-drawer-icon').click();
            await expect(page.locator('#tags_div .inline-drawer-icon')).toHaveClass(/\bup\b/);
            await panelSettled(page);
            expect(await underlayHitUnderPanel(page)).toBe(true);
            await expect(page.locator('#creatorInfoWrapper')).not.toHaveAttribute('style', /clip-path/);

            await setStackedDrawers(page, true);
            expect(await underlayHitUnderPanel(page)).toBe(false);

            await setStackedDrawers(page, false);
            expect(await underlayHitUnderPanel(page)).toBe(true);
            await expect(page.locator('#creatorInfoWrapper')).not.toHaveAttribute('style', /clip-path/);
        } finally {
            await deleteOpenCharacter(page);
        }
    });
});

/**
 * Whether the collapsed tag row under the input has exactly the part the open suggestion list covers cut out of it.
 * (The row ignores the pointer, so this reads the cut itself rather than hit-testing.)
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean | null>} true if cut, false if nothing is cut, null if cut wrongly
 */
async function rowCutUnderSuggestions(page) {
    return page.evaluate(() => {
        const menu = [...document.querySelectorAll('.ui-autocomplete')].find(el => getComputedStyle(el).display !== 'none');
        const under = document.getElementById('tags_div_preview');
        const m = menu.getBoundingClientRect();
        const u = under.getBoundingClientRect();
        const expected = [
            Math.max(m.left, u.left) - u.left,
            Math.max(m.top, u.top) - u.top,
            Math.min(m.right, u.right) - u.left,
            Math.min(m.bottom, u.bottom) - u.top,
        ];
        if (expected[2] <= expected[0] || expected[3] <= expected[1]) {
            throw new Error('the suggestion list does not cover the tag row');
        }
        const clip = under.style.clipPath;
        if (!clip) {
            return false;
        }
        const points = clip.replace(/^polygon\(evenodd,\s*/, '').replace(/\)$/, '').split(',').slice(5)
            .map(p => p.trim().split(/\s+/).map(parseFloat));
        const hole = [points[0][0], points[0][1], points[2][0], points[2][1]];
        return hole.every((v, i) => Math.abs(v - expected[i]) < 1) ? true : null;
    });
}

/**
 * Opens the suggestion list of #tagInput.
 * @param {import('@playwright/test').Page} page
 */
async function openSuggestions(page) {
    await page.locator('#tagInput').fill('');
    await page.locator('#tagInput').blur();
    await page.locator('#tagInput').focus();
    await expect(page.locator('.ui-autocomplete .ui-menu-item').first()).toBeVisible();
}

/**
 * Closes #tagInput's suggestion list. Not with Escape: that also closes the character info drawer.
 * @param {import('@playwright/test').Page} page
 */
async function closeSuggestions(page) {
    // @ts-ignore jQuery UI
    await page.evaluate(() => window['$']('#tagInput').autocomplete('close'));
}

test.describe('tag suggestion list overlay', () => {
    test.beforeEach(testSetup.awaitST);
    test.afterEach(async ({ page }) => setStackedDrawers(page, false));

    test('with stacked drawers on, the open list hides the form it covers, and the hole goes when it closes', async ({ page }) => {
        await setStackedDrawers(page, true);
        await openCharacterWithTags(page);
        try {
            await openSuggestions(page);
            expect(await rowCutUnderSuggestions(page)).toBe(true);

            await closeSuggestions(page);
            await expect(page.locator('.ui-autocomplete .ui-menu-item').first()).toBeHidden();
            await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#char-info-panel *')]
                .filter(el => /** @type {HTMLElement} */ (el).style.clipPath).length)).toBe(0);
        } finally {
            await deleteOpenCharacter(page);
        }
    });

    test('with stacked drawers off the list clips nothing, and it clips again once the setting is on', async ({ page }) => {
        await setStackedDrawers(page, false);
        await openCharacterWithTags(page);
        try {
            await openSuggestions(page);
            expect(await rowCutUnderSuggestions(page)).toBe(false);

            await setStackedDrawers(page, true);
            await openSuggestions(page);
            expect(await rowCutUnderSuggestions(page)).toBe(true);

            await setStackedDrawers(page, false);
            await openSuggestions(page);
            expect(await rowCutUnderSuggestions(page)).toBe(false);
        } finally {
            await closeSuggestions(page);
            await deleteOpenCharacter(page);
        }
    });
});
