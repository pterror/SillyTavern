import { test, expect } from './fixtures.js';
import { chatBox, pasteInto, testSetup } from './frontent-test-utils.js';

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>} its avatar
 */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', `Hello from ${name}.`);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return (await response.text()).trim();
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar, { switchMenu: true });
    }, avatar);
    await expect.poll(() => page.evaluate(() => {
        // @ts-ignore
        return typeof stTest.context().chat[0]?.node_id;
    }), { timeout: 15000 }).toBe('string');
}

/** @param {import('@playwright/test').Page} page */
async function openSeraphina(page) {
    await page.evaluate(async () => {
        // @ts-ignore
        await stTest.context().executeSlashCommandsWithOptions('/go Seraphina');
    });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => stTest.context().onlineStatus), { timeout: 15000 }).not.toBe('no_connection');
    await expect(chatBox(page)).toHaveCount(1, { timeout: 10000 });
}

/** @param {import('@playwright/test').Page} page */
function boxText(page) {
    return page.evaluate(async () => (await import('/scripts/chat-box.js')).chatBoxText());
}

/** @param {import('@playwright/test').Page} page */
async function emptyBox(page) {
    await page.evaluate(async () => (await import('/scripts/chat-box.js')).writeChatBox(''));
}

test.describe('the chat box', () => {
    test('is an editor whose text is what was typed, with a placeholder when empty', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openSeraphina(page);
        await expect(page.locator('#chat_box .cm-placeholder')).toBeVisible();
        await chatBox(page).click();
        await page.keyboard.type('Hello *there*');
        expect(await boxText(page)).toBe('Hello *there*');
        await emptyBox(page);
    });

    test('its text and placeholder are drawn as message text is: its size, from the start of the line', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openSeraphina(page);
        await emptyBox(page);
        const style = (/** @type {string} */ selector) => page.locator(selector).first().evaluate((element) => {
            const { fontSize, textAlign } = getComputedStyle(element);
            return { fontSize, textAlign };
        });
        const message = await style('#chat .mes_text .chat-text');
        await expect(page.locator('#chat_box .cm-placeholder')).toBeVisible();
        expect(await style('#chat_box .cm-content')).toEqual({ fontSize: message.fontSize, textAlign: 'start' });
        expect((await style('#chat_box .cm-placeholder')).fontSize).toBe(message.fontSize);
        await chatBox(page).click();
        await page.keyboard.type('typed');
        expect(await style('#chat_box .cm-content')).toEqual({ fontSize: message.fontSize, textAlign: 'start' });
        await emptyBox(page);
    });

    test('its toolbar holds every formatting command, which run on its text', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openSeraphina(page);
        const buttons = page.locator('#chat_box .chat-editor-toolbar button');
        await expect(buttons).toHaveCount(11);
        await chatBox(page).click();
        await page.locator('#chat_box .chat-editor-toolbar button[data-tool="bold"]').click();
        await page.keyboard.type('loud');
        expect(await boxText(page)).toBe('**loud**');
        await emptyBox(page);
    });

    test('a paste can be switched with the picker', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openSeraphina(page);
        await chatBox(page).click();
        await pasteInto(chatBox(page), { 'text/html': '<p>Hello <b>bold</b>.</p>', 'text/plain': 'Hello bold.' });
        expect(await boxText(page)).toBe('Hello **bold**.');
        const picker = page.locator('#chat_box .paste-picker');
        await expect(picker.locator('.paste-picker-toggle')).toContainText('Keep formatting');
        await page.keyboard.press('Control+Alt+v');
        expect(await boxText(page)).toContain('<b>bold</b>');
        await page.keyboard.press('Control+Alt+v');
        expect(await boxText(page)).toBe('Hello bold.');
        await emptyBox(page);
    });

    test('is drawn again at once when a setting its text is drawn by changes', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openSeraphina(page);
        await chatBox(page).click();
        await page.keyboard.type('a <b>loud</b> word');
        const bold = page.locator('#chat_box .cm-content b');
        await expect(bold).toHaveCount(1);
        const showTags = (/** @type {boolean} */ on) => page.evaluate((on) => {
            const box = /** @type {HTMLInputElement} */ (document.getElementById('encode_tags'));
            box.checked = on;
            box.dispatchEvent(new Event('input', { bubbles: true }));
        }, on);
        await showTags(true);
        await expect(bold).toHaveCount(0);
        await expect(page.locator('#chat_box .cm-content')).toContainText('<b>loud</b>');
        await showTags(false);
        await expect(bold).toHaveCount(1);
        await emptyBox(page);
    });

    test('Enter sends the message and empties the box; Shift+Enter adds a line', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openSeraphina(page);
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.send_on_enter = 1;
        });
        await chatBox(page).click();
        await page.keyboard.type('one');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('two');
        expect(await boxText(page)).toBe('one\ntwo');
        await page.keyboard.press('Enter');
        await expect.poll(() => page.evaluate(() => {
            // @ts-ignore
            return stTest.context().chat.some(m => m.is_user && m.mes === 'one\ntwo');
        })).toBe(true);
        expect(await boxText(page)).toBe('');
        await page.evaluate(() => {
            // @ts-ignore
            stTest.context().stopGeneration?.();
        });
    });

    test('a slash command typed in it runs on Enter, and the box is empty after', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openSeraphina(page);
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.send_on_enter = 1;
        });
        await chatBox(page).click();
        await page.keyboard.type('/setvar key=chatBoxRan yes');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Enter');
        // @ts-ignore
        await expect.poll(() => page.evaluate(() => stTest.context().chatMetadata.variables?.chatBoxRan)).toBe('yes');
        expect(await boxText(page)).toBe('');
    });

    test('/setinput writes it', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openSeraphina(page);
        await page.evaluate(async () => {
            // @ts-ignore
            await stTest.context().executeSlashCommandsWithOptions('/setinput written by a command');
        });
        await expect(chatBox(page)).toHaveText('written by a command');
        expect(await boxText(page)).toBe('written by a command');
        await emptyBox(page);
    });

    test('slash commands, macros and mentions are suggested as typed', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openSeraphina(page);
        await chatBox(page).click();
        await page.keyboard.type('/sen');
        await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
        await page.keyboard.press('Escape');
        await emptyBox(page);
        await page.keyboard.type('hi {{us');
        await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
        await page.keyboard.press('Escape');
        await emptyBox(page);
        await page.keyboard.type('hi @');
        await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
        await page.keyboard.press('Escape');
        await emptyBox(page);
    });

    test('a macro is a pill', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openSeraphina(page);
        await chatBox(page).click();
        await page.keyboard.type('Hi {{user}}');
        await page.keyboard.press('Escape');
        await page.keyboard.type(' and more');
        await expect(page.locator('#chat_box .macro-pill')).toHaveCount(1);
        await emptyBox(page);
    });
});

test.describe('the chat box\'s drafts', () => {
    test('what was written stays with the chat left, and is there again on coming back, also after a reload', async ({ page }) => {
        await testSetup.awaitST({ page });
        const first = await createCharacter(page, `Draft A ${stamp()}`);
        const second = await createCharacter(page, `Draft B ${stamp()}`);
        await openCharacter(page, first);
        await expect(chatBox(page)).toHaveCount(1, { timeout: 10000 });
        await chatBox(page).click();
        await page.keyboard.type('half a reply to A');

        const left = page.waitForRequest(request => request.url().endsWith('/api/chats/open') && (JSON.parse(request.postData() ?? '{}').leaving ?? []).some(d => d.text === 'half a reply to A'));
        await openCharacter(page, second);
        await left;
        await expect.poll(() => boxText(page)).toBe('');
        await chatBox(page).click();
        await page.keyboard.type('to B');

        await openCharacter(page, first);
        await expect.poll(() => boxText(page)).toBe('half a reply to A');

        const kept = page.waitForRequest(request => request.url().endsWith('/api/chats/draft'));
        await page.keyboard.type(', and more');
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        await (await kept).response();
        await expect.poll(() => page.evaluate(async () => {
            // @ts-ignore
            const headers = stTest.context().getRequestHeaders();
            const response = await fetch('/api/chats/open', { method: 'POST', headers, body: JSON.stringify({ avatar_url: stTest.context().characters[stTest.context().characterId]?.avatar }) });
            return (await response.json()).draft?.text;
        })).toBe('half a reply to A, and more');

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, second);
        await expect.poll(() => boxText(page)).toBe('to B');
    });

    test('a macro in a draft is drawn as its value, as the server sends it with the draft; one only known when sent says so', async ({ page }) => {
        await testSetup.awaitST({ page });
        const name = `Pill ${stamp()}`;
        const first = await createCharacter(page, name);
        const second = await createCharacter(page, `Pill B ${stamp()}`);
        await openCharacter(page, first);
        await expect(chatBox(page)).toHaveCount(1, { timeout: 10000 });
        await chatBox(page).click();
        await page.keyboard.type('Hi {{char}} {{input}}');
        await openCharacter(page, second);
        await openCharacter(page, first);
        await expect.poll(() => boxText(page)).toBe('Hi {{char}} {{input}}');
        const pills = page.locator('#chat_box .macro-pill');
        await expect(pills).toHaveCount(2);
        await expect(pills.first()).toHaveText(name);
        await expect(pills.nth(1)).toHaveAttribute('data-macro-note', 'Filled in when sent');
        await emptyBox(page);
    });

    test('text the server never confirmed is in the browser, and goes with the next open of any chat after a reload', async ({ page }) => {
        await testSetup.awaitST({ page });
        const first = await createCharacter(page, `Copy A ${stamp()}`);
        const second = await createCharacter(page, `Copy B ${stamp()}`);
        await openCharacter(page, first);
        await expect(chatBox(page)).toHaveCount(1, { timeout: 10000 });
        await chatBox(page).click();
        await page.keyboard.type('never saved');
        const copies = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('ChatBoxCopy:')).length);
        expect(await copies()).toBe(1);
        // The save the page sends as it goes fails, in the page itself: a request made while a page unloads is not
        // reliably seen by Playwright's routing.
        await page.evaluate(() => {
            const send = window.fetch;
            window.fetch = (resource, init) => {
                if (!String(resource).includes('/api/chats/draft')) return send(resource, init);
                sessionStorage.setItem('test:draft-refused', String(Number(sessionStorage.getItem('test:draft-refused') ?? 0) + 1));
                return Promise.reject(new TypeError('offline'));
            };
        });
        await page.reload();
        await testSetup.awaitST({ page });
        expect(Number(await page.evaluate(() => sessionStorage.getItem('test:draft-refused')))).toBeGreaterThan(0);

        await openCharacter(page, second);
        await expect.poll(copies).toBe(0);
        await openCharacter(page, first);
        await expect.poll(() => boxText(page)).toBe('never saved');
    });

    test('two tabs writing in one chat both keep what they wrote: a draft saved in one is laid under what the other is typing', async ({ page, context }) => {
        test.setTimeout(90000);
        await testSetup.awaitST({ page });
        const avatar = await createCharacter(page, `Two tabs ${stamp()}`);
        await openCharacter(page, avatar);
        await expect(chatBox(page)).toHaveCount(1, { timeout: 10000 });
        await chatBox(page).click();
        await page.keyboard.type('Second tab typing. ');

        const other = await context.newPage();
        await other.goto(page.url());
        await testSetup.awaitST({ page: other });
        await openCharacter(other, avatar);
        await expect(chatBox(other)).toHaveCount(1, { timeout: 10000 });
        await chatBox(other).click();
        await other.keyboard.type('First tab wrote this.');
        const kept = other.waitForRequest(request => request.url().endsWith('/api/chats/draft'));
        await other.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        await (await kept).response();

        await expect.poll(() => boxText(page), { timeout: 15000 }).toContain('First tab wrote this.');
        expect(await boxText(page)).toContain('Second tab typing.');
        await page.keyboard.type('More.');
        expect(await boxText(page)).toContain('More.');
        await other.close();
    });
});
