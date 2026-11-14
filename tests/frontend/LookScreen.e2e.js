import { test, expect } from './fixtures.js';
import { openCharacterManagementDrawer, testSetup } from './frontent-test-utils.js';
import { deleteWorld, makeWorld } from './worlds.js';

const unique = (/** @type {string} */ name) => `${name} ${Date.now()}${Math.floor(Math.random() * 1000)}`;

const WORLD = {
    0: {
        uid: 0, key: ['Ilse Varro', 'ledger'], keysecondary: [], comment: 'Ilse Varro', content: 'Ilse keeps the inn.', constant: false,
        selective: true, order: 100, position: 0, depth: 4, disable: false, probability: 100, useProbability: true, displayIndex: 0,
        extensions: { names: ['Ilse Varro'] },
    },
};

const screen = (/** @type {import('@playwright/test').Page} */ page) => page.locator('.look-screen');

/**
 * The computed style of the Look screen's preview of the name.
 * @param {import('@playwright/test').Page} page
 * @param {string} property
 */
const previewStyle = (page, property) =>
    screen(page).locator('.look-big .named').evaluate((name, property) => getComputedStyle(name).getPropertyValue(property), property);

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function openLook(page, name) {
    await makeWorld(page, name, WORLD);
    const pane = page.locator('#Worldbuilding');
    await pane.locator('.wb-card-open', { hasText: 'Ilse Varro' }).first().click();
    await pane.getByRole('button', { name: 'Look', exact: true }).click();
    await expect(screen(page).locator('.look-back')).toHaveText('Ilse Varro');
}

test.describe('the Look screen', () => {
    test.beforeEach(testSetup.awaitST);

    test('opens from an entry, turns an effect on in a state, moves it to every name, and resets it', async ({ page }) => {
        const name = unique('Look');
        await openLook(page, name);
        await screen(page).getByRole('radio', { name: 'Word hover or focus' }).click();
        const glow = screen(page).getByRole('button', { name: 'Glow', exact: true });
        await expect(glow).not.toHaveClass(/look-on/);
        await glow.click();
        await expect(glow).toHaveClass(/look-on/);
        await expect.poll(() => previewStyle(page, 'filter')).toContain('drop-shadow');

        const appliesTo = screen(page).getByLabel('Applies to');
        await expect(appliesTo).toHaveValue(/\d/);
        await expect(appliesTo.locator('option:checked')).toHaveText('Just Ilse Varro');
        await appliesTo.selectOption({ label: 'Every name' });
        await expect(appliesTo.locator('option:checked')).toHaveText('Every name');

        await screen(page).getByRole('button', { name: 'Reset' }).click();
        await expect(glow).not.toHaveClass(/look-on/);
        await expect.poll(() => previewStyle(page, 'filter')).toBe('none');

        await screen(page).locator('.look-back').click();
        await expect(screen(page)).toHaveCount(0);
        await expect(page.locator('#Worldbuilding .wb-entry')).toBeVisible();
        await deleteWorld(page, name);
    });

    test('a new shared look is made in the world and used; the CSS panel takes declarations the controls don\'t cover', async ({ page }) => {
        const name = unique('Shared');
        await openLook(page, name);
        await screen(page).getByRole('button', { name: '+ Shared look' }).click();
        await screen(page).getByRole('menuitem', { name: 'New for this world…' }).click();
        const dialog = page.locator('dialog[open]');
        await dialog.locator('input').fill('Lantern House regulars');
        await dialog.locator('input').press('Enter');
        const chip = screen(page).locator('.look-uchip');
        await expect(chip).toContainText('Lantern House regulars');
        await expect(chip.locator('.look-uat')).toHaveText('This world');

        await screen(page).getByRole('button', { name: 'CSS', exact: true }).click();
        const typed = screen(page).getByLabel('Custom CSS');
        await typed.fill('word-spacing: 2px;');
        await typed.blur();
        await expect.poll(() => previewStyle(page, 'word-spacing')).toBe('2px');
        await expect(typed).toHaveValue('word-spacing: 2px;');

        await chip.getByRole('button').click();
        await expect(chip).toHaveCount(0);
        await screen(page).locator('.look-back').click();
        await deleteWorld(page, name);
    });

    test('opens from a character, whose chain is every name then just it', async ({ page }) => {
        await openCharacterManagementDrawer(page);
        await page.locator('.character_select', { hasText: 'Alice' }).first().click();
        await page.locator('#character_look_inline').click();
        await expect(screen(page).locator('.look-back')).toHaveText('Alice');
        await screen(page).getByRole('button', { name: 'Color', exact: true }).click();
        await expect(screen(page).getByLabel('Applies to').locator('option')).toHaveText([
            'Every name',
            'Just Alice',
            'New for all worlds…',
        ]);
        await expect(screen(page).locator('.look-cp')).toHaveText('Character');
        await screen(page).getByRole('button', { name: 'Reset' }).click();
        await screen(page).locator('.look-back').click();
        await expect(page.locator('#character_look_inline')).toBeVisible();
    });
});
