import { test, expect } from './fixtures.js';
import { chatBox, testSetup } from './frontent-test-utils.js';

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

        const left = page.waitForRequest(request => request.url().endsWith('/api/chats/open') && JSON.parse(request.postData() ?? '{}').leaving?.text === 'half a reply to A');
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
});
