import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello there.');
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
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
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ enabled?: boolean, tokenizer?: number }} settings
 */
async function saveCounterSettings(page, { enabled = true, tokenizer }) {
    await page.evaluate(async ({ enabled, tokenizer }) => {
        // @ts-ignore
        const context = stTest.context();
        context.powerUserSettings.message_token_count_enabled = enabled;
        if (tokenizer !== undefined) context.powerUserSettings.tokenizer = tokenizer;
        await (await import('/script.js')).saveSettings();
    }, { enabled, tokenizer });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function appendExchange(page, avatar) {
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = stTest.context();
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        const opening = await ensureOpeningRow(0);
        const response = await fetch('/api/chats/message/append', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, after_node_id: opening, messages: [
                { name: 'User', is_user: true, mes: 'How far is it to the river from the old mill?', send_date: new Date().toISOString(), extra: { token_count: 999 } },
                { name: 'Bot', is_user: false, mes: 'Two days on foot, if the bridge still stands.', send_date: new Date().toISOString(), extra: {} },
            ] }),
        });
        if (!response.ok) throw new Error(`append failed: ${response.status}`);
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function reopenChat(page) {
    await page.evaluate(async () => {
        const { openCharacterChat, getCurrentChatId } = await import('/script.js');
        await openCharacterChat(getCurrentChatId());
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {string[]}
 */
function countRequests(page) {
    /** @type {string[]} */
    const seen = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/tokenizers/count') seen.push(request.postData() ?? '');
    });
    return seen;
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<(number|null)[]>}
 */
function shownCounts(page) {
    // @ts-ignore
    return page.evaluate(() => stTest.context().chat.map(m => (typeof m.extra?.token_count === 'number' ? m.extra.token_count : null)));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} length
 */
async function expectCountersShowChat(page, length) {
    await expect(page.locator('#chat .mes')).toHaveCount(length);
    const counts = await shownCounts(page);
    expect(counts).toHaveLength(length);
    for (const [mesId, count] of counts.entries()) {
        expect(count).toBeGreaterThan(0);
        await expect(page.locator(`#chat .mes[mesid="${mesId}"] .tokenCounterDisplay`)).toHaveText(`${count}t`);
    }
    return /** @type {number[]} */ (counts);
}

test('an opened chat\'s messages come with their counts, and the page asks for none', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `Counters-${stamp}`);
    await saveCounterSettings(page, { enabled: true });
    await openCharacter(page, avatar);
    await expect(page.locator('#chat .mes')).toHaveCount(1);
    await appendExchange(page, avatar);

    const requested = countRequests(page);
    await reopenChat(page);
    const counts = await expectCountersShowChat(page, 3);
    expect(counts[1]).not.toBe(999);
    await page.waitForTimeout(500);
    expect(requested).toEqual([]);
});

test('an edited message shows the count of its new text, and the page asks for none', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `Edit counts-${stamp}`);
    await saveCounterSettings(page, { enabled: true });
    await openCharacter(page, avatar);
    await appendExchange(page, avatar);
    await reopenChat(page);
    const before = await expectCountersShowChat(page, 3);

    const requested = countRequests(page);
    await page.locator('#chat .mes[mesid="2"] .mes_edit').click();
    await page.locator('.mes_editor .cm-content').fill('Two days on foot, if the bridge still stands, and three more if it has fallen into the water since the spring floods.');
    await page.locator('#chat .mes[mesid="2"] .mes_edit_done').click();
    await expect.poll(async () => (await shownCounts(page))[2]).toBeGreaterThan(before[2]);
    const after = await expectCountersShowChat(page, 3);
    await page.waitForTimeout(500);
    expect(requested).toEqual([]);

    await reopenChat(page);
    expect(await expectCountersShowChat(page, 3)).toEqual(after);
});

test('a changed tokenizer recounts the shown messages in the answer to the change', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `Tokenizer counts-${stamp}`);
    await saveCounterSettings(page, { enabled: true, tokenizer: 0 });
    await openCharacter(page, avatar);
    await appendExchange(page, avatar);
    await reopenChat(page);
    const estimated = await expectCountersShowChat(page, 3);

    const requested = countRequests(page);
    await page.evaluate(() => {
        // @ts-ignore
        $('#tokenizer').val('1').trigger('change');
    });
    await expect.poll(() => shownCounts(page)).not.toEqual(estimated);
    const recounted = await expectCountersShowChat(page, 3);
    await page.waitForTimeout(500);
    expect(requested).toEqual([]);

    await page.evaluate(async () => (await import('/script.js')).saveSettings());
    await reopenChat(page);
    expect(await expectCountersShowChat(page, 3)).toEqual(recounted);
});

test('a counter turned on shows the shown messages\' counts in the answer to turning it on', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `Toggle counts-${stamp}`);
    await saveCounterSettings(page, { enabled: false });
    await openCharacter(page, avatar);
    await appendExchange(page, avatar);
    await reopenChat(page);
    await expect(page.locator('#chat .mes')).toHaveCount(3);

    const requested = countRequests(page);
    await page.locator('#messageTokensEnabled').evaluate((box) => {
        /** @type {HTMLInputElement} */ (box).checked = true;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => shownCounts(page)).not.toContain(null);
    await expectCountersShowChat(page, 3);
    await page.waitForTimeout(500);
    expect(requested).toEqual([]);
});

test('an alternative swiped to shows its own count, and the page asks for none', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `Swipe counts-${stamp}`);
    await saveCounterSettings(page, { enabled: true });
    await openCharacter(page, avatar);
    await appendExchange(page, avatar);
    await reopenChat(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = stTest.context();
        const response = await fetch('/api/chats/message/alternative', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, sibling_node_id: context.chat[2].node_id, content: { name: 'Bot', is_user: false, mes: 'Far.', send_date: new Date().toISOString(), extra: {} } }),
        });
        if (!response.ok) throw new Error(`alternative failed: ${response.status}`);
    }, avatar);
    await reopenChat(page);
    const before = await expectCountersShowChat(page, 3);

    // @ts-ignore
    const { swipeId, other } = await page.evaluate(() => { const m = stTest.context().chat[2]; return { swipeId: m.swipe_id, other: m.swipes[1 - m.swipe_id] }; });
    const requested = countRequests(page);
    await page.locator(`#chat .mes[mesid="2"] ${swipeId === 0 ? '.swipe_right' : '.swipe_left'}`).click();
    await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toHaveText(other);
    await expect.poll(async () => (await shownCounts(page))[2]).not.toBe(before[2]);
    await expectCountersShowChat(page, 3);
    await page.waitForTimeout(500);
    expect(requested).toEqual([]);
});
