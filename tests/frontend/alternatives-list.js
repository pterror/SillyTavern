import { expect } from '@playwright/test';
import { openInfoTab } from './frontent-test-utils.js';

/** @param {import('@playwright/test').Page} page */
export const greetingsList = page => page.locator('dialog.alternatives');

/**
 * @param {import('@playwright/test').Page} page
 * @param {number|string} which
 */
export function greetingRow(page, which) {
    const rows = greetingsList(page).locator('li.alternative');
    if (typeof which === 'number') return rows.nth(which);
    const exactly = new RegExp(`^\\s*${which.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
    return rows.filter({ has: page.locator('.alternative-text', { hasText: exactly }) });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} count
 */
export async function openGreetingsList(page, count) {
    await openInfoTab(page, 'greeting');
    await page.locator('.open_alternate_greetings').click();
    await expect(greetingsList(page).locator('li.alternative')).toHaveCount(count, { timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Response} response
 */
export async function answerOf(response) {
    return JSON.parse((await response.text()).split('\n')[0]);
}

/**
 * @param {import('@playwright/test').Page} page
 */
export function greetingAnswer(page) {
    return page.waitForResponse(r => new URL(r.url()).pathname === '/api/ui/action'
        && r.request().postDataJSON()?.type === 'alternatives.greeting', { timeout: 15000 });
}

/**
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
    const box = greetingsList(page).locator('.alternatives-add');
    await box.locator('textarea').fill(text);
    await operate(page, () => box.getByRole('button', { name: 'Add' }).click());
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
 * @param {import('@playwright/test').Page} page
 * @param {number|string} index
 */
export async function listMoveToEnd(page, index) {
    await operate(page, () => greetingRow(page, index).locator('.alternative-drag').press('End'));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number|string} index
 * @param {{ refused?: boolean }} [options]
 */
export async function listToggleDefault(page, index, options) {
    await operate(page, () => greetingRow(page, index).locator('.alternative-default').click(), options);
}
