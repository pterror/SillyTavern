import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// The welcome screen's recent chats are the conversations by their last activity, one row each, titled by the
// bookmark's label, else the character's name.

/** @param {import('@playwright/test').Page} page @param {string} name */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello.');
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
}

/** Opens the character and says one thing in its chat. @param {import('@playwright/test').Page} page @param {string} avatar @param {string} text */
async function speak(page, avatar, text) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
    await page.evaluate(async ({ avatar, text }) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        const opening = await ensureOpeningRow(0);
        const response = await fetch('/api/chats/message/append', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, after_node_id: opening, messages: [{ name: 'User', is_user: true, mes: text, send_date: new Date().toISOString(), extra: {} }] }),
        });
        if (!response.ok) throw new Error(`append failed: ${response.status}`);
    }, { avatar, text });
}

/** @param {import('@playwright/test').Page} page */
function recentChats(page) {
    return page.evaluate(async () => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/chats/recent', { method: 'POST', headers, body: JSON.stringify({ max: 50, pinned: [] }) });
        if (!response.ok) throw new Error(`recent failed: ${response.status}`);
        return response.json();
    });
}

test('recent chats are the conversations by last activity, one row each', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const first = await createCharacter(page, `RecentOne-${stamp}`);
    const second = await createCharacter(page, `RecentTwo-${stamp}`);
    await speak(page, first, 'one');
    await speak(page, second, 'two');

    // Each character's conversation of the tab's session, the last act first.
    let rows = (await recentChats(page)).filter((/** @type {any} */ r) => [first, second].includes(r.avatar));
    expect(rows.map((/** @type {any} */ r) => r.avatar)).toEqual([second, first]);
    expect(rows.every((/** @type {any} */ r) => /^s[^.]+\.\d+\.jsonl$/.test(r.file_name) && r.label === null)).toBe(true);
    expect(rows.map((/** @type {any} */ r) => r.mes)).toEqual(['two', 'one']);

    // The page shows them in that order, titled by the character's name (a label would be shown after it).
    await page.evaluate(async () => (await import('/script.js')).closeCurrentChat());
    const titles = page.locator('.recentChat .chatName');
    await expect(titles.first()).toBeVisible();
    const shown = await page.locator('.recentChat').evaluateAll(items => items.map(item => [item.getAttribute('data-avatar'), item.querySelector('.chatName')?.textContent?.replace(/\s+/g, ' ').trim()]));
    expect(shown.filter(([avatar]) => [first, second].includes(String(avatar)))).toEqual([[second, `RecentTwo-${stamp} – RecentTwo-${stamp}`], [first, `RecentOne-${stamp} – RecentOne-${stamp}`]]);

    // A bookmark of the first character, once someone acts in it, is a row of its own, titled by its label.
    await speak(page, first, 'one again');
    const name = await page.evaluate(async () => {
        const { forkChat } = await import('/scripts/bookmarks.js');
        return forkChat(1);
    });
    expect(name).toMatch(/ - Branch #1$/);
    await page.evaluate(async ({ avatar }) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        const response = await fetch('/api/chats/message/append', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, after_node_id: await ensureOpeningRow(0), messages: [{ name: 'User', is_user: true, mes: 'in the bookmark', send_date: new Date().toISOString(), extra: {} }] }),
        });
        if (!response.ok) throw new Error(`append failed: ${response.status}`);
    }, { avatar: first });
    rows = (await recentChats(page)).filter((/** @type {any} */ r) => [first, second].includes(r.avatar));
    expect(rows.map((/** @type {any} */ r) => r.file_name)).toContain(`${name}.jsonl`);
    expect(rows.filter((/** @type {any} */ r) => r.file_name === `${name}.jsonl`)).toHaveLength(1);
});

test('past the most recent ones, older chats load a page at a time, in order', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatars = [];
    for (let i = 0; i < 5; i++) {
        const avatar = await createCharacter(page, `Older${i}-${stamp}`);
        avatars.push(avatar);
        await speak(page, avatar, `said ${i}`);
    }
    await page.evaluate(async () => {
        const { accountStorage } = await import('/scripts/util/AccountStorage.js');
        accountStorage.setItem('recentChatsSettings', JSON.stringify({ maxDisplayed: 2, collapsedDisplayed: 1 }));
        await (await import('/script.js')).closeCurrentChat();
    });
    const names = () => page.locator('#chat .welcomePanel .recentChat:not(.hidden)').evaluateAll(els => els.map(el => el.getAttribute('data-avatar')));
    const older = page.locator('#chat .welcomePanel button.loadOlderChats');
    await expect(page.locator('#chat .welcomePanel .recentChat')).toHaveCount(2, { timeout: 15000 });
    await expect(older).toBeHidden();
    await page.locator('#chat .welcomePanel button.showMoreChats').click();
    await expect(older).toBeVisible();
    expect(await names()).toEqual([avatars[4], avatars[3]]);

    await older.click();
    await expect.poll(names).toEqual([avatars[4], avatars[3], avatars[2], avatars[1]]);
    await older.click();
    await expect.poll(async () => (await names()).slice(0, 5)).toEqual([avatars[4], avatars[3], avatars[2], avatars[1], avatars[0]]);
});
