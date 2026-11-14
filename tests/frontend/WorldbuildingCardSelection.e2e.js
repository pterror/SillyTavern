import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { deleteWorld, heldWorlds, makeWorld } from './worlds.js';

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
 * Sends an action as the tab, and hands the tab the views it answers with.
 * @param {import('@playwright/test').Page} page
 * @param {string} type
 * @param {unknown} payload
 */
async function act(page, type, payload) {
    return page.evaluate(async ({ type, payload }) => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const { takeViews } = await import('/scripts/new-ui.js');
        const sent = await fetch('/api/ui/action', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ type, payload }) });
        const answers = (await sent.text()).split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line));
        for (const answer of answers) takeViews(answer.views);
        return answers[0];
    }, { type, payload });
}

/**
 * Clicks a card with keys held, from the pointer's resting place, so no hover card stands over it.
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 * @param {('Shift' | 'ControlOrMeta')[]} modifiers
 */
async function clickCard(page, title, modifiers) {
    await page.mouse.move(0, 0);
    await expect(pane(page).locator('.wb-hover')).toHaveCount(0);
    await card(page, title).locator('.wb-card-open').click({ modifiers });
}

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

    test('the bulk bar deletes the selected cards after asking, and each can be restored', async ({ page }) => {
        const name = await openCoast(page);
        const ids = await Promise.all(['Ilse Varro', 'The Tidegate'].map(title => card(page, title).getAttribute('data-entry')));
        await clickCard(page, 'Ilse Varro', ['ControlOrMeta']);
        await clickCard(page, 'The Tidegate', ['ControlOrMeta']);
        await bar(page).getByRole('button', { name: 'Delete' }).click();
        await expect(page.locator('dialog[open]')).toContainText('Delete 2 entries?');
        await page.locator('dialog[open] .popup-button-ok').click();
        await expect(pane(page).locator('.wb-card')).toHaveCount(TITLES.length - 2);
        await expect(card(page, 'Ilse Varro')).toHaveCount(0);
        await expect(bar(page)).toHaveCount(0);

        const book = (await heldWorlds(page))[name].id;
        for (const entry of ids) expect(await act(page, 'worldbuilding.restoreEntry', { book, entry })).toMatchObject({ ok: true });
        await expect(card(page, 'Ilse Varro')).toHaveCount(1);
        await expect(card(page, 'The Tidegate')).toHaveCount(1);
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
