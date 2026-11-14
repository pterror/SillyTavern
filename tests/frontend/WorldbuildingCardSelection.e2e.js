import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { deleteWorld, makeWorld } from './worlds.js';

const unique = (/** @type {string} */ name) => `${name} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
const SHOTS = process.env.WB_SHOTS ?? null;

const TITLES = ['Saltmarrow', 'The Lantern House', 'Ilse Varro', 'The Tidegate', 'Harbormaster Quell', 'Season of fog'];
const ENTRIES = Object.fromEntries(TITLES.map((title, uid) => [uid, {
    uid, key: [title], keysecondary: [], comment: title, content: `${title} is on the coast.`, constant: false, selective: true,
    order: 100, position: 0, depth: 4, disable: false, probability: 100, useProbability: true, displayIndex: uid,
    extensions: { names: [title] },
}]));

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding');
const card = (/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ title) =>
    pane(page).locator('.wb-card', { has: page.locator('.wb-card-name', { hasText: new RegExp(`^${title}$`) }) });
const box = (/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ title) =>
    pane(page).getByRole('checkbox', { name: `Select ${title}`, exact: true });
const bar = (/** @type {import('@playwright/test').Page} */ page) => page.locator('.wb-bulk');

/** @param {import('@playwright/test').Page} page */
async function openCoast(page) {
    const name = unique('Cards');
    await makeWorld(page, name, ENTRIES);
    await expect(pane(page).locator('.wb-card')).toHaveCount(TITLES.length);
    return name;
}

/**
 * Clicks a card with keys held.
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 * @param {('Shift' | 'ControlOrMeta')[]} modifiers
 */
async function clickCard(page, title, modifiers) {
    await card(page, title).locator('.wb-card-open').click({ modifiers });
}

/** @param {import('@playwright/test').Page} page */
const toast = page => page.locator('#toast-container .toast');

test.describe('selecting cards', () => {
    test.beforeEach(testSetup.awaitST);

    test('a card\'s checkbox shows when pointed at, and stays shown on every card while anything is selected', async ({ page }) => {
        const name = await openCoast(page);
        await expect(box(page, 'Ilse Varro')).toHaveCSS('opacity', '0');
        await card(page, 'Ilse Varro').hover();
        await expect(box(page, 'Ilse Varro')).toHaveCSS('opacity', '1');
        await box(page, 'Ilse Varro').click();
        await expect(bar(page)).toContainText('1 selected');
        await expect(card(page, 'Ilse Varro')).toHaveClass(/wb-sel/);
        await page.mouse.move(0, 0);
        await expect(box(page, 'Saltmarrow')).toHaveCSS('opacity', '1');
        await expect(box(page, 'Ilse Varro')).toBeChecked();
        await box(page, 'Ilse Varro').click();
        await expect(bar(page)).toHaveCount(0);
        await expect(box(page, 'Saltmarrow')).toHaveCSS('opacity', '0');
        await deleteWorld(page, name);
    });

    test('Shift-click picks the run in drawn order and Ctrl-click adds or removes one, without opening it', async ({ page }) => {
        const name = await openCoast(page);
        await box(page, 'The Lantern House').click();
        await clickCard(page, 'Harbormaster Quell', ['Shift']);
        await expect(bar(page)).toContainText('4 selected');
        for (const title of ['The Lantern House', 'Ilse Varro', 'The Tidegate', 'Harbormaster Quell']) await expect(box(page, title)).toBeChecked();
        await expect(box(page, 'Saltmarrow')).not.toBeChecked();
        await page.screenshot({ path: `${SHOTS ?? 'test-results'}/cards-selected.png` });

        await clickCard(page, 'Ilse Varro', ['ControlOrMeta']);
        await expect(bar(page)).toContainText('3 selected');
        await clickCard(page, 'Season of fog', ['ControlOrMeta']);
        await expect(bar(page)).toContainText('4 selected');
        await expect(box(page, 'Season of fog')).toBeChecked();
        await expect(pane(page).locator('.wb-entry')).toHaveCount(0);
        await deleteWorld(page, name);
    });

    test('Ctrl+A selects all matching, as rows do; Escape clears', async ({ page }) => {
        const name = await openCoast(page);
        await pane(page).locator('.wb-front-name').first().hover();
        await page.keyboard.press('ControlOrMeta+a');
        await expect(bar(page)).toContainText(`All ${TITLES.length} matching`);
        await box(page, 'Saltmarrow').click();
        await expect(bar(page)).toContainText(`All ${TITLES.length} matching except 1`);
        await page.keyboard.press('Escape');
        await expect(bar(page)).toHaveCount(0);
        await deleteWorld(page, name);
    });

    test('the bulk bar deletes the selected cards after asking, and the toast\'s Undo brings back just those', async ({ page }) => {
        const name = await openCoast(page);
        await clickCard(page, 'Ilse Varro', ['ControlOrMeta']);
        await clickCard(page, 'The Tidegate', ['ControlOrMeta']);
        await bar(page).getByRole('button', { name: 'Delete' }).click();
        await expect(page.locator('dialog[open]')).toContainText('Delete 2 entries?');
        await expect(page.locator('dialog[open]')).toContainText('You can undo it.');
        await page.locator('dialog[open] .popup-button-ok').click();
        await expect(pane(page).locator('.wb-card')).toHaveCount(TITLES.length - 2);
        await expect(bar(page)).toHaveCount(0);
        const said = toast(page).filter({ hasText: 'Deleted 2 entries' });
        await said.getByRole('button', { name: 'Undo' }).click();
        await expect(card(page, 'Ilse Varro')).toHaveCount(1);
        await expect(card(page, 'The Tidegate')).toHaveCount(1);
        await expect(pane(page).locator('.wb-card')).toHaveCount(TITLES.length);
        await deleteWorld(page, name);
    });

    test('one card deleted says its name, and Undo restores it', async ({ page }) => {
        const name = await openCoast(page);
        await box(page, 'Season of fog').click();
        await bar(page).getByRole('button', { name: 'Delete' }).click();
        await page.locator('dialog[open] .popup-button-ok').click();
        await expect(card(page, 'Season of fog')).toHaveCount(0);
        await toast(page).filter({ hasText: 'Deleted Season of fog' }).getByRole('button', { name: 'Undo' }).click();
        await expect(card(page, 'Season of fog')).toHaveCount(1);
        await deleteWorld(page, name);
    });

    test('a card\'s hover card closes when the pointer goes to another card, and never stands in its way', async ({ page }) => {
        const name = await openCoast(page);
        await card(page, 'The Lantern House').hover();
        const hover = pane(page).locator('.wb-hover');
        await expect(hover).toContainText('The Lantern House');
        await card(page, 'Harbormaster Quell').locator('.wb-card-open').click({ modifiers: ['ControlOrMeta'] });
        await expect(bar(page)).toContainText('1 selected');
        await expect(box(page, 'Harbormaster Quell')).toBeChecked();
        await expect(hover).not.toContainText('The Lantern House');
        await deleteWorld(page, name);
    });
});

test.describe('selecting cards by touch', () => {
    test.use({ hasTouch: true });
    test.beforeEach(testSetup.awaitST);

    test('Select in the view bar turns taps into selection, and back', async ({ page }) => {
        const name = await openCoast(page);
        const select = pane(page).locator('.wb-vtabs').getByRole('button', { name: 'Select', exact: true });
        await select.tap();
        await expect(select).toHaveAttribute('aria-pressed', 'true');
        await expect(box(page, 'Saltmarrow')).toHaveCSS('opacity', '1');
        await card(page, 'Saltmarrow').locator('.wb-card-open').tap();
        await card(page, 'The Tidegate').locator('.wb-card-open').tap();
        await expect(bar(page)).toContainText('2 selected');
        await expect(pane(page).locator('.wb-entry')).toHaveCount(0);
        await card(page, 'Saltmarrow').locator('.wb-card-open').tap();
        await expect(bar(page)).toContainText('1 selected');

        await select.tap();
        await expect(select).toHaveAttribute('aria-pressed', 'false');
        await card(page, 'Ilse Varro').locator('.wb-card-open').tap();
        await expect(pane(page).locator('.wb-entry .wb-entry-name')).toContainText('Ilse Varro');
        await deleteWorld(page, name);
    });
});
