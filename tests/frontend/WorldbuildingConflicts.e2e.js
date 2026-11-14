import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { deleteWorld, makeWorld, openWorld } from './worlds.js';

const unique = (/** @type {string} */ name) => `${name} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
const SHOTS = process.env.WB_SHOTS ?? null;

const ENTRIES = {
    0: {
        uid: 0, key: ['The Tidegate'], keysecondary: [], comment: 'The Tidegate', content: 'A stone lock on the delta.', constant: false,
        selective: true, order: 100, position: 0, depth: 4, disable: false, probability: 100, useProbability: true, displayIndex: 0,
        extensions: { names: ['The Tidegate'] },
    },
};

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding');

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} world
 */
async function storedText(page, world) {
    return page.evaluate(async (world) => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const read = await fetch('/api/worldinfo/entry/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: world, uid: 0 }) });
        return (await read.json()).entry.content;
    }, world);
}

/**
 * Another tab of the same browser, on the world's entry.
 * @param {import('@playwright/test').Page} page
 * @param {string} world
 */
async function secondTab(page, world) {
    const other = await page.context().newPage();
    await other.goto('/');
    await testSetup.awaitST({ page: other });
    await openWorld(other, world);
    await openEntry(other);
    return other;
}

/** @param {import('@playwright/test').Page} page */
async function openEntry(page) {
    await pane(page).locator('.wb-card-open', { hasText: 'The Tidegate' }).first().click();
    await expect(pane(page).locator('.wb-entry .wb-entry-name')).toContainText('The Tidegate');
}

/**
 * Holds what the server pushes to the tab until let go, so what it edits meanwhile is made against the version it read.
 * @param {import('@playwright/test').Page} page
 * @param {boolean} held
 */
async function holdPushes(page, held) {
    await page.evaluate(async (held) => {
        const { newUi } = await import('/scripts/new-ui.js');
        const ui = /** @type {any} */ (newUi());
        if (held) {
            ui.heldReceive ??= ui.receive;
            ui.held = [];
            ui.receive = (/** @type {unknown} */ push) => ui.held.push(push);
        } else if (ui.heldReceive) {
            ui.receive = ui.heldReceive;
            delete ui.heldReceive;
            for (const push of ui.held) ui.receive(push);
        }
    }, held);
}

/**
 * Edits the entry's text in one change: `remove` characters after `after` (or the start) replaced with `type`.
 * @param {import('@playwright/test').Page} page
 * @param {{ after?: string, remove?: number, type: string }} edit
 */
async function editText(page, { after = '', remove = 0, type }) {
    await pane(page).getByRole('textbox', { name: 'Content' }).click();
    const editor = pane(page).locator('.cm-content');
    await editor.click();
    await page.keyboard.press('Control+Home');
    const text = await editor.innerText();
    for (let i = 0; i < (after === '' ? 0 : text.indexOf(after) + after.length); i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < remove; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.insertText(type);
    await page.keyboard.press('Escape');
}

test.describe('two tabs on one entry', () => {
    test.beforeEach(testSetup.awaitST);

    test('changes in different places merge without asking', async ({ page }) => {
        const name = unique('Merge');
        await makeWorld(page, name, ENTRIES);
        await openEntry(page);
        const other = await secondTab(page, name);
        await holdPushes(other, true);

        await editText(page, { type: 'Old: ' });
        await expect.poll(() => storedText(page, name)).toBe('Old: A stone lock on the delta.');
        await editText(other, { after: 'delta', type: ', leaking' });
        await expect(pane(other).locator('.wb-text')).toHaveText('Old: A stone lock on the delta, leaking.');
        await expect(other.locator('dialog[open]')).toHaveCount(0);
        await expect.poll(() => storedText(page, name)).toBe('Old: A stone lock on the delta, leaking.');
        await holdPushes(other, false);
        await expect(pane(page).locator('.wb-text')).toHaveText('Old: A stone lock on the delta, leaking.');
        await other.close();
        await deleteWorld(page, name);
    });

    /** @type {{ choice: string, kept: string, answer: (dialog: import('@playwright/test').Locator, page: import('@playwright/test').Page) => Promise<void> }[]} */
    const answers = [
        {
            choice: 'Keep mine',
            kept: 'A iron lock on the delta.',
            answer: async (dialog, page) => {
                await page.screenshot({ path: `${SHOTS ?? 'test-results'}/conflict-dialog.png` });
                await dialog.getByRole('button', { name: 'Keep mine' }).click();
            },
        },
        {
            choice: 'Keep theirs',
            kept: 'A brick lock on the delta.',
            answer: dialog => dialog.getByRole('button', { name: 'Keep theirs' }).click(),
        },
        {
            choice: 'Edit merged',
            kept: 'A brass lock on the delta.',
            answer: async (dialog, page) => {
                await dialog.getByRole('button', { name: 'Edit merged…' }).click();
                const field = page.locator('dialog[open] textarea');
                await expect(field).toHaveValue('A brickiron lock on the delta.');
                await field.fill('A brass lock on the delta.');
                await page.locator('dialog[open] .popup-button-ok').click();
            },
        },
    ];
    for (const { choice, kept, answer } of answers) {
        test(`the same words changed in both ask which to keep: ${choice}`, async ({ page }) => {
            const name = unique('Conflict');
            await makeWorld(page, name, ENTRIES);
            await openEntry(page);
            const other = await secondTab(page, name);
            await holdPushes(other, true);

            await editText(page, { after: 'A ', remove: 5, type: 'brick' });
            await expect.poll(() => storedText(page, name)).toBe('A brick lock on the delta.');
            await editText(other, { after: 'A ', remove: 5, type: 'iron' });
            const dialog = other.locator('dialog[open]');
            await expect(dialog).toContainText('Changed in another tab');
            await expect(dialog.locator('.wb-diff-mine', { hasText: 'iron' })).toBeVisible();
            await expect(dialog.locator('.wb-diff-theirs', { hasText: 'brick' })).toBeVisible();
            await answer(dialog, other);
            await expect(other.locator('dialog[open]')).toHaveCount(0);
            await expect.poll(() => storedText(page, name)).toBe(kept);
            await holdPushes(other, false);
            await expect(pane(other).locator('.wb-text')).toHaveText(kept);
            await expect(pane(page).locator('.wb-text')).toHaveText(kept);
            await other.close();
            await deleteWorld(page, name);
        });
    }

    test('a tab closed while asking leaves its text for the next tab to carry', async ({ page }) => {
        const name = unique('Closed');
        await makeWorld(page, name, ENTRIES);
        await openEntry(page);
        const other = await secondTab(page, name);
        await holdPushes(other, true);

        await editText(page, { after: 'A ', remove: 5, type: 'brick' });
        await expect.poll(() => storedText(page, name)).toBe('A brick lock on the delta.');
        await editText(other, { after: 'A ', remove: 5, type: 'iron' });
        await expect(other.locator('dialog[open]')).toContainText('Changed in another tab');
        await other.close();

        const next = await secondTab(page, name);
        const dialog = next.locator('dialog[open]');
        await expect(dialog.locator('.wb-diff-mine', { hasText: 'iron' })).toBeVisible();
        await dialog.getByRole('button', { name: 'Keep mine' }).click();
        await expect.poll(() => storedText(page, name)).toBe('A iron lock on the delta.');
        await next.close();
        await page.reload();
        await testSetup.awaitST({ page });
        await openWorld(page, name);
        await openEntry(page);
        await expect(page.locator('dialog[open]')).toHaveCount(0);
        await deleteWorld(page, name);
    });
});
