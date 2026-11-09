import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings
 * @returns {Promise<string>}
 */
async function createCharacter(page, name, greetings) {
    return page.evaluate(async ({ name, greetings }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', greetings[0]);
        for (const text of greetings.slice(1)) form.append('alternate_greetings', text);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, greetings });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
}

/** @param {import('@playwright/test').Page} page */
function shownText(page) {
    return page.evaluate(() => {
        // @ts-ignore
        return stTest.context().chat[0]?.mes;
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} n
 */
async function pageTo(page, n) {
    await page.locator('.greeting-pager-input').fill(String(n));
    await page.locator('.greeting-pager-input').press('Enter');
    await expect(page.locator('.greeting-pager-input')).toHaveValue(String(n));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} index
 */
function greetingRow(page, index) {
    return page.locator('dialog.alternatives li.alternative').nth(index);
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('a card has each greeting text once, and the pager and the chat copy greetings to each other', () => {
    test.beforeEach(testSetup.awaitST);

    test('confirming another greeting\'s text keeps the field open, unsaved, with a link that pages to that greeting', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`];
        const avatar = await createCharacter(page, `Same-${s}`, g);
        await openCharacter(page, avatar);
        await openInfoTab(page, 'greeting');
        await pageTo(page, 2);

        await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
        await page.locator('#greeting_field').fill(g[0]);
        const refused = page.waitForResponse(r => new URL(r.url()).pathname === '/api/characters/greetings/edit');
        await page.locator('.field_edit_done[data-for="greeting_field"]').click();
        expect((await refused).status()).toBe(409);
        const note = page.locator('#greeting_same_note');
        await expect(note).toHaveText('Same as greeting 1');
        await expect(page.locator('#charInfoTab_greeting')).toHaveClass(/field_editing/);

        await note.locator('a').click();
        await expect(page.locator('#charInfoTab_greeting')).not.toHaveClass(/field_editing/);
        await expect(note).toBeHidden();
        await expect(page.locator('.greeting-pager-input')).toHaveValue('1');
        await expect(page.locator('#greeting_field')).toHaveValue(g[0]);
        await pageTo(page, 2);
        await expect(page.locator('#greeting_field')).toHaveValue(g[1]);
    });

    test('the create form keeps a greeting with another\'s text open and unsaved too', async ({ page }) => {
        const s = stamp();
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'createcharacter');
        await openInfoTab(page, 'greeting');
        await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
        await page.locator('#greeting_field').fill(`First ${s}`);
        await page.locator('.field_edit_done[data-for="greeting_field"]').click();
        await page.locator('.greeting-pager-add').click();
        await page.locator('#greeting_field').fill(`First ${s}`);
        await page.locator('.field_edit_done[data-for="greeting_field"]').click();
        await expect(page.locator('#greeting_same_note')).toHaveText('Same as greeting 1');
        await expect(page.locator('#charInfoTab_greeting')).toHaveClass(/field_editing/);
        await page.locator('#greeting_field').fill(`Second ${s}`);
        await expect(page.locator('#greeting_same_note')).toBeHidden();
        await page.locator('.field_edit_done[data-for="greeting_field"]').click();
        await expect(page.locator('#charInfoTab_greeting')).not.toHaveClass(/field_editing/);
        await expect(page.locator('.greeting-pager-total')).toHaveText('/2');
    });

    test('"Use in chat" makes the shown greeting the chat\'s opening, and "Show in character info" pages to the opening\'s greeting', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `Copy-${s}`, g);
        await openCharacter(page, avatar);
        expect(await shownText(page)).toBe(g[0]);
        await openInfoTab(page, 'greeting');

        await pageTo(page, 3);
        const used = page.waitForResponse(r => new URL(r.url()).pathname === '/api/chats/openings/use-greeting');
        await page.locator('.greeting-pager-use').click();
        expect((await used).ok()).toBe(true);
        await expect.poll(() => shownText(page), { timeout: 10000 }).toBe(g[2]);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g[2]);

        await pageTo(page, 1);
        const button = page.locator('#chat .mes[mesid="0"] .mes_show_greeting');
        await expect(button).not.toHaveClass(/disabled/);
        const shown = page.waitForResponse(r => new URL(r.url()).pathname === '/api/characters/greetings/show');
        await page.evaluate(() => {
            // @ts-ignore
            $('#chat .mes[mesid="0"] .mes_show_greeting').trigger('click');
        });
        expect((await shown).ok()).toBe(true);
        await expect(page.locator('.greeting-pager-input')).toHaveValue('3');
        await expect(page.locator('#greeting_field')).toHaveValue(g[2]);
    });

    test('"Show in character info" is enabled exactly while the opening is its greeting with that greeting\'s current text', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`];
        const avatar = await createCharacter(page, `Live-${s}`, g);
        await openCharacter(page, avatar);
        await page.evaluate(async () => {
            const { ensureOpeningRow } = await import('/scripts/chat-store.js');
            await ensureOpeningRow(0);
        });
        const button = page.locator('#chat .mes[mesid="0"] .mes_show_greeting');
        await expect(button).not.toHaveClass(/disabled/);

        await openInfoTab(page, 'greeting');
        await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
        await page.locator('#greeting_field').fill(`Zero edited ${s}`);
        await page.locator('.field_edit_done[data-for="greeting_field"]').click();
        await expect(page.locator('#charInfoTab_greeting')).not.toHaveClass(/field_editing/);
        await expect(button).toHaveClass(/disabled/, { timeout: 10000 });
        expect(await shownText(page)).toBe(g[0]);

        const used = page.waitForResponse(r => new URL(r.url()).pathname === '/api/chats/openings/use-greeting');
        await page.locator('.greeting-pager-use').click();
        expect((await used).ok()).toBe(true);
        await expect.poll(() => shownText(page), { timeout: 10000 }).toBe(`Zero edited ${s}`);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_show_greeting')).not.toHaveClass(/disabled/);
    });

    test('the greetings list keeps an edit or an add with another greeting\'s text open, with a link to that greeting', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `ListSame-${s}`, g);
        await openCharacter(page, avatar);
        await openInfoTab(page, 'greeting');
        await page.locator('.open_alternate_greetings').click();
        const row = greetingRow(page, 2);
        await expect(row).toContainText(g[2], { timeout: 10000 });

        await row.locator('.alternative-edit').click();
        await row.locator('textarea').fill(g[0]);
        await row.getByRole('button', { name: 'Save' }).click();
        const note = row.locator('.alternatives-same');
        await expect(note).toHaveText('Same as greeting 1');
        await expect(row.locator('textarea')).toHaveValue(g[0]);
        await row.locator('textarea').fill(`${g[0]}!`);
        await expect(note).toHaveCount(0);
        await row.locator('textarea').fill(g[1]);
        await row.getByRole('button', { name: 'Save' }).click();
        await expect(note).toHaveText('Same as greeting 2');
        await note.locator('a').click();
        await expect(row.locator('textarea')).toHaveCount(0);
        await expect(row.locator('.alternative-text')).toHaveText(g[2]);
        await expect(greetingRow(page, 1)).toHaveClass(/selected/);

        const add = page.locator('dialog.alternatives .alternatives-add');
        await add.locator('textarea').fill(g[2]);
        await add.getByRole('button', { name: 'Add' }).click();
        await expect(add.locator('.alternatives-same')).toHaveText('Same as greeting 3');
        await expect(add.locator('textarea')).toHaveValue(g[2]);
        await add.locator('.alternatives-same a').click();
        await expect(add.locator('textarea')).toHaveValue('');
        await expect(greetingRow(page, 2)).toHaveClass(/selected/);
        await expect(page.locator('dialog.alternatives li.alternative')).toHaveCount(3);
    });
});
