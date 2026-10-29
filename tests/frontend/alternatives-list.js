import { expect } from '@playwright/test';
import { openInfoTab } from './frontent-test-utils.js';

// Driving a character's greetings list (the alternatives list, packages/areas/alternatives) from a spec.

/** @param {import('@playwright/test').Page} page */
export const greetingsList = page => page.locator('dialog.alternatives');

/**
 * A greeting's row: the one at `which` (an index), or the one whose text is `which` (once the list shows it).
 * @param {import('@playwright/test').Page} page
 * @param {number|string} which
 */
export function greetingRow(page, which) {
    const rows = greetingsList(page).locator('li.alternative:not(.alternatives-new)');
    if (typeof which === 'number') return rows.nth(which);
    const exactly = new RegExp(`^\\s*${which.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
    return rows.filter({ has: page.locator('.alternative-text', { hasText: exactly }) });
}

/**
 * Opens the shown character's greetings list from character info.
 * @param {import('@playwright/test').Page} page
 * @param {number} count How many greetings it should list.
 */
export async function openGreetingsList(page, count) {
    await openInfoTab(page, 'greeting');
    await page.locator('.open_alternate_greetings').click();
    await expect(greetingsList(page).locator('li.alternative:not(.alternatives-new)')).toHaveCount(count, { timeout: 10000 });
}

/**
 * An action's answer: JSON, or NDJSON (views read in parts) whose first line is the answer.
 * @param {import('@playwright/test').Response} response
 */
export async function answerOf(response) {
    return JSON.parse((await response.text()).split('\n')[0]);
}

/**
 * The answer to the list's next greeting operation.
 * @param {import('@playwright/test').Page} page
 */
export function greetingAnswer(page) {
    return page.waitForResponse(r => new URL(r.url()).pathname === '/api/ui/action'
        && r.request().postDataJSON()?.type === 'alternatives.greeting', { timeout: 15000 });
}

/**
 * Sends one greeting operation from the list and waits for it to be done (`ok` unless `refused`).
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} act
 * @param {{ refused?: boolean }} [options]
 */
async function operate(page, act, { refused = false } = {}) {
    const answer = greetingAnswer(page);
    await act();
    expect((await answerOf(await answer)).ok).toBe(!refused);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number|string} index
 * @param {string} text
 * @param {{ refused?: boolean }} [options]
 */
export async function listEdit(page, index, text, options) {
    const row = greetingRow(page, index);
    await row.locator('.alternative-edit').click();
    await row.locator('textarea').fill(text);
    await operate(page, () => row.getByRole('button', { name: 'Save' }).click(), options);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
export async function listAdd(page, text) {
    await greetingsList(page).locator('.alternatives-add').click();
    const editor = greetingsList(page).locator('.alternatives-new');
    await editor.locator('textarea').fill(text);
    await operate(page, () => editor.getByRole('button', { name: 'Save' }).click());
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number|string} index
 * @param {{ refused?: boolean }} [options]
 */
export async function listDelete(page, index, options) {
    await greetingRow(page, index).locator('.alternative-delete-greeting').click();
    await operate(page, () => page.locator('dialog.popup:not(.alternatives) .popup-button-ok').click(), options);
}

/**
 * Moves the greeting at `index` to the end of the list.
 * @param {import('@playwright/test').Page} page
 * @param {number|string} index
 */
export async function listMoveToEnd(page, index) {
    await operate(page, () => greetingRow(page, index).locator('.alternative-drag').press('End'));
}

/**
 * Makes the greeting the default, or, when it is, no greeting the default.
 * @param {import('@playwright/test').Page} page
 * @param {number|string} index
 * @param {{ refused?: boolean }} [options]
 */
export async function listToggleDefault(page, index, options) {
    await operate(page, () => greetingRow(page, index).locator('.alternative-default').click(), options);
}
