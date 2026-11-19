import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function measure(page) {
    return page.evaluate(() => ({
        row: document.getElementById('tags_div_preview').getBoundingClientRect().height,
        chip: document.querySelector('#tags_div_preview .tag')?.getBoundingClientRect().height ?? null,
        chipIndent: (document.querySelector('#tags_div_preview .tag')?.getBoundingClientRect().left ?? NaN) - document.getElementById('tags_div_preview').getBoundingClientRect().left,
        below: document.getElementById('creatorInfoWrapper').getBoundingClientRect().top - document.getElementById('tags_div').getBoundingClientRect().top,
    }));
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function createCharacter(page) {
    const name = `TagRowReservedTest-${Date.now()}`;
    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button_label').click();
    await page.waitForFunction(n => window['stTest'].context().name2 === n, name);
    await expect(page.locator('#char-info-panel')).toHaveClass(/openDrawer/);
    await page.locator('#tagInput').waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} tag
 */
async function addTag(page, tag) {
    await page.locator('#tagInput').fill('');
    await page.locator('#tagInput').pressSequentially(tag);
    await page.locator('.st-autocomplete-menu [role="option"]', { hasText: new RegExp(`^\\s*${tag}\\s*$`) }).first().click();
    await page.locator('#tagInput').fill('');
    await page.locator('#tagInput').blur();
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

test.describe('character info tag row', () => {
    test.beforeEach(testSetup.awaitST);

    test('keeps one chip of height with no tags, so the first tag and removing it move nothing below', async ({ page }) => {
        await createCharacter(page);
        try {
            await expect(page.locator('#tags_div_preview .tag')).toHaveCount(0);
            const empty = await measure(page);
            expect(empty.row).toBeGreaterThan(0);

            await addTag(page, `reserved${Date.now()}`);
            await expect(page.locator('#tags_div_preview .tag')).toHaveCount(1);
            const one = await measure(page);
            expect(one.chip).toBe(empty.row);
            expect(one.chipIndent).toBe(0);
            expect(one.row).toBe(empty.row);
            expect(one.below).toBe(empty.below);

            await page.locator('#tagList .tag .tag_remove').first().dispatchEvent('click');
            await expect(page.locator('#tags_div_preview .tag')).toHaveCount(0);
            const removed = await measure(page);
            expect(removed.row).toBe(empty.row);
            expect(removed.below).toBe(empty.below);
        } finally {
            await deleteOpenCharacter(page);
        }
    });

    test('is exactly one chip row at any font size: more chips are cut off at the edge, not wrapped', async ({ page }) => {
        await createCharacter(page);
        try {
            const stamp = Date.now();
            const tags = [`long${stamp}${'x'.repeat(120)}`, ...Array.from({ length: 12 }, (_, n) => `row${stamp}n${n}`)];
            for (const tag of tags) {
                await addTag(page, tag);
            }
            await expect(page.locator('#tags_div_preview .tag')).toHaveCount(tags.length);

            for (const size of ['10px', '15px', '22px', '31px']) {
                const row = await page.evaluate(async size => {
                    document.documentElement.style.setProperty('--mainFontSize', size);
                    await new Promise(resolve => requestAnimationFrame(resolve));
                    const preview = document.getElementById('tags_div_preview');
                    const box = preview.getBoundingClientRect();
                    const chips = [...preview.querySelectorAll('.tag')].map(el => el.getBoundingClientRect());
                    return {
                        height: box.height,
                        width: box.width,
                        chipHeight: chips[0].height,
                        tops: [...new Set(chips.map(c => c.top - box.top))],
                        bottoms: [...new Set(chips.map(c => c.bottom - box.top))],
                        firstWidth: chips[0].width,
                        lastLeft: chips.at(-1).left - box.left,
                        contentHeight: preview.scrollHeight,
                    };
                }, size);
                expect(row.height, size).toBe(row.chipHeight);
                expect(row.tops, size).toEqual([0]);
                expect(row.bottoms, size).toEqual([row.height]);
                expect(row.contentHeight, size).toBe(Math.round(row.height));
                expect(row.firstWidth, size).toBeLessThanOrEqual(row.width);
                expect(row.lastLeft, size).toBeGreaterThan(row.width);
            }
        } finally {
            await page.evaluate(() => document.documentElement.style.removeProperty('--mainFontSize'));
            await deleteOpenCharacter(page);
        }
    });
});
