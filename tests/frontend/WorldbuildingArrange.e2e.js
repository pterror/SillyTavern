import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { deleteWorld, makeWorld } from './worlds.js';

const unique = (/** @type {string} */ name) => `${name} ${Date.now()}${Math.floor(Math.random() * 1000)}`;

/**
 * @param {number} uid
 * @param {string} title
 * @param {string} text
 * @param {number} [inside]
 */
const entry = (uid, title, text, inside) => ({
    uid, key: [title], keysecondary: [], comment: title, content: text, constant: false, selective: true, order: 100,
    position: 0, depth: 4, disable: false, probability: 100, useProbability: true, displayIndex: uid,
    extensions: {
        names: [title],
        ...(inside === undefined ? {} : { relations: [{ kind: 1, target: inside, position: `a${uid}` }] }),
    },
});

const COAST = {
    0: entry(0, 'Saltmarrow', 'The last town on the delta.'),
    1: entry(1, 'The Lantern House', 'The inn at the top of the stairs.', 0),
    2: entry(2, 'Ilse Varro', 'Ilse keeps the inn and its ledger.', 1),
    3: entry(3, 'The back room', 'Behind the bar.', 1),
    4: entry(4, 'The Pale Choir', 'Salvagers who drowned and came back.'),
    5: entry(5, 'Sister Oriel', 'She leads the low-water song.', 4),
    6: entry(6, 'The Hymn of Low Water', 'The song the Choir sings.', 4),
};

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding');

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 */
const region = (page, title) =>
    pane(page).locator('.wb-region', { has: page.locator(':scope > .wb-region-top > .wb-region-head .wb-region-name', { hasText: title }) });

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 */
const card = (page, title) => pane(page).locator('.wb-card', { hasText: title }).first();

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 */
async function openMenu(page, title) {
    await card(page, title).hover();
    await card(page, title).locator('.wb-card-more').click();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} item
 * @param {string} typed
 * @param {string} target
 */
async function pickTarget(page, item, typed, target) {
    await pane(page).getByRole('menuitem', { name: item }).click();
    await pane(page).locator('.wb-card-pick input').fill(typed);
    await pane(page).locator('.wb-card-pick .wb-pick-row', { hasText: target }).click();
}

/**
 * Drags a card by the mouse to a point inside a region, holding Alt or not.
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 * @param {import('@playwright/test').Locator} into
 * @param {boolean} alt
 */
async function drag(page, title, into, alt) {
    await card(page, title).scrollIntoViewIfNeeded();
    const from = await card(page, title).boundingBox();
    const to = await into.boundingBox();
    if (!from || !to) throw new Error('nothing to drag');
    await page.mouse.move(from.x + 60, from.y + 30);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + 40, { steps: 3 });
    await page.mouse.move(to.x + to.width - 40, to.y + 40, { steps: 10 });
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.move(to.x + to.width - 30, to.y + 42, { steps: 2 });
    await expect(pane(page).locator('.wb-intent')).toBeVisible();
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
}

test.describe('arranging a world', () => {
    test.beforeEach(testSetup.awaitST);

    test('a card\'s menu moves it, also puts it in another group, and takes it out', async ({ page }) => {
        const name = unique('Arrange');
        await makeWorld(page, name, COAST, { relationKinds: [{ id: 1, name: 'in' }] });

        await openMenu(page, 'Sister Oriel');
        await pickTarget(page, 'Add to…', 'lantern', 'The Lantern House');
        await expect(region(page, 'The Lantern House').locator('.wb-card', { hasText: 'Sister Oriel' })).toBeVisible();
        await expect(region(page, 'The Pale Choir').locator('.wb-card', { hasText: 'Sister Oriel' })).toBeVisible();

        await region(page, 'The Lantern House').locator('.wb-card', { hasText: 'Sister Oriel' }).hover();
        await region(page, 'The Lantern House').locator('.wb-card', { hasText: 'Sister Oriel' }).locator('.wb-card-more').click();
        await pane(page).getByRole('menuitem', { name: 'Remove from The Lantern House' }).click();
        await expect(region(page, 'The Lantern House').locator('.wb-card', { hasText: 'Sister Oriel' })).toHaveCount(0);

        await openMenu(page, 'The Hymn of Low Water');
        await pickTarget(page, 'Move to…', 'saltmarrow', 'Saltmarrow');
        await expect(region(page, 'Saltmarrow').locator(':scope > .wb-grid > .wb-card', { hasText: 'The Hymn of Low Water' })).toBeVisible();
        await expect(region(page, 'The Pale Choir').locator('.wb-card', { hasText: 'The Hymn of Low Water' })).toHaveCount(0);
        await deleteWorld(page, name);
    });

    test('dragging a card to another group moves it there; with Alt held it is kept in both', async ({ page }) => {
        const name = unique('Drag');
        await page.setViewportSize({ width: 1280, height: 1200 });
        await makeWorld(page, name, COAST, { relationKinds: [{ id: 1, name: 'in' }] });

        await drag(page, 'Sister Oriel', region(page, 'The Lantern House'), false);
        await expect(region(page, 'The Lantern House').locator('.wb-card', { hasText: 'Sister Oriel' })).toBeVisible();
        await expect(region(page, 'The Pale Choir').locator('.wb-card', { hasText: 'Sister Oriel' })).toHaveCount(0);

        await drag(page, 'The Hymn of Low Water', region(page, 'The Lantern House'), true);
        await expect(region(page, 'The Lantern House').locator('.wb-card', { hasText: 'The Hymn of Low Water' })).toBeVisible();
        await expect(region(page, 'The Pale Choir').locator('.wb-card', { hasText: 'The Hymn of Low Water' })).toBeVisible();

        const inn = region(page, 'The Lantern House').locator(':scope > .wb-grid > .wb-card');
        const before = await inn.allTextContents();
        await inn.filter({ hasText: 'The back room' }).locator('.wb-card-open').focus();
        await page.keyboard.press('Alt+ArrowLeft');
        await expect.poll(async () => (await inn.allTextContents()).findIndex(text => text.includes('The back room')))
            .toBe(before.findIndex(text => text.includes('The back room')) - 1);
        await deleteWorld(page, name);
    });

    test('selected words in an entry become a new entry, a name of another entry, or a trigger of one', async ({ page }) => {
        const name = unique('Write');
        await makeWorld(page, name, COAST, { relationKinds: [{ id: 1, name: 'in' }] });
        await card(page, 'Ilse Varro').locator('.wb-card-open').click();
        await expect(pane(page).locator('.wb-entry .wb-entry-name')).toContainText('Ilse Varro');

        const selectWords = async (/** @type {string} */ words) => {
            await pane(page).locator('.wb-text').evaluate((text, words) => {
                const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                    const at = (node.textContent ?? '').indexOf(words);
                    if (at === -1) continue;
                    const range = document.createRange();
                    range.setStart(node, at);
                    range.setEnd(node, at + words.length);
                    getSelection()?.removeAllRanges();
                    getSelection()?.addRange(range);
                    text.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    return;
                }
                throw new Error(`no "${words}" in the text`);
            }, words);
        };

        await selectWords('ledger');
        await pane(page).getByRole('menuitem', { name: 'New entry “ledger”' }).click();
        await expect(pane(page).locator('.wb-text .wb-link', { hasText: 'ledger' })).toBeVisible();

        await selectWords('the inn');
        await pane(page).getByRole('menuitem', { name: 'Add as name key to…' }).click();
        await pane(page).locator('.wb-selmenu input').fill('lantern');
        await pane(page).locator('.wb-selmenu .wb-pick-row', { hasText: 'The Lantern House' }).click();
        await expect(pane(page).locator('.wb-text .wb-link', { hasText: 'the inn' })).toBeVisible();

        await selectWords('keeps');
        await pane(page).getByRole('menuitem', { name: 'Add as key to…' }).click();
        await pane(page).locator('.wb-selmenu input').fill('back room');
        await pane(page).locator('.wb-selmenu .wb-pick-row', { hasText: 'The back room' }).click();
        await pane(page).locator('.wb-rels-world').click();
        await card(page, 'The back room').locator('.wb-card-open').click();
        await expect(pane(page).locator('.wb-keys').getByLabel('“keeps”, key')).toBeVisible();
        await deleteWorld(page, name);
    });
});
