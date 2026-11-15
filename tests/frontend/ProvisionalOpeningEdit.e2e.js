import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

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
    await expect.poll(() => page.evaluate(() => {
        // @ts-ignore
        return typeof stTest.context().chat[0]?.node_id;
    }), { timeout: 10000 }).toBe('string');
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function storedOpenings(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/chats/openings', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, offset: 0, limit: 100 }) });
        const body = await response.json();
        return body.alternatives.map((/** @type {any} */ a) => ({ stored: a.node_id != null, mes: a.mes }));
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function opening(page) {
    return page.evaluate(() => {
        // @ts-ignore
        const m = stTest.context().chat[0];
        return { mes: m.mes, node_id: m.node_id, swipes: [...m.swipes] };
    });
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('editing a card greeting in the chat', () => {
    test.beforeEach(testSetup.awaitST);

    test('saves the edit as a stored opening, and the card\'s untouched greeting stays offered, after a reload too', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `ChatEditsOpening-${s}`, g);
        await openCharacter(page, avatar);
        expect((await opening(page)).node_id.startsWith('card:')).toBe(true);

        const edited = `Zero edited in chat ${s}`;
        await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
        await page.locator('.mes_editor .cm-content').fill(edited);
        await page.locator('#chat .mes[mesid="0"] .mes_edit_done').click();
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(edited, { timeout: 10000 });

        await expect.poll(() => storedOpenings(page, avatar), { timeout: 10000 }).toEqual([
            { stored: false, mes: g[0] },
            { stored: true, mes: edited },
            { stored: false, mes: g[1] },
            { stored: false, mes: g[2] },
        ]);
        await expect.poll(async () => (await opening(page)).swipes, { timeout: 10000 }).toEqual([g[0], edited, g[1], g[2]]);
        const now = await opening(page);
        expect(now.mes).toBe(edited);
        expect(now.node_id.startsWith('card:')).toBe(false);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(edited, { timeout: 10000 });
        const reloaded = await opening(page);
        expect(reloaded.node_id).toBe(now.node_id);
        expect(reloaded.swipes).toEqual([g[0], edited, g[1], g[2]]);
    });
});

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} swipeId
 */
async function showOpening(page, swipeId) {
    await page.evaluate(async (swipeId) => {
        const { swipe } = await import('/script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        // @ts-ignore
        const current = stTest.context().chat[0].swipe_id ?? 0;
        await swipe(null, swipeId > current ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: swipeId });
    }, swipeId);
    await expect.poll(async () => (await opening(page)).mes, { timeout: 10000 }).toBe((await opening(page)).swipes[swipeId]);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {boolean} on
 */
async function saveWhileTyping(page, on) {
    await page.evaluate(async (on) => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.auto_save_msg_edits = on;
    }, on);
}

/** @param {import('@playwright/test').Page} page */
const notices = page => page.evaluate(() => document.querySelector('#toast-container')?.textContent ?? '');

test.describe('saving an edit of a card greeting not stored in the chat', () => {
    test.beforeEach(testSetup.awaitST);
    test.afterEach(async ({ page }) => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await saveWhileTyping(page, false);
    });

    test('with saving while typing on, the edit keeps saving into the opening its first save stored', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `TypingSaves-${s}`, g);
        await openCharacter(page, avatar);
        await showOpening(page, 1);
        await saveWhileTyping(page, true);

        const stored = page.waitForResponse(r => new URL(r.url()).pathname === '/api/chats/message/select', { timeout: 10000 });
        await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
        await page.locator('.mes_editor .cm-content').fill(`One edited ${s}`);
        expect((await stored).ok()).toBe(true);
        await expect.poll(async () => (await opening(page)).node_id.startsWith('card:'), { timeout: 10000 }).toBe(false);
        const edited = page.waitForResponse(r => new URL(r.url()).pathname === '/api/chats/message/edit', { timeout: 10000 });
        await page.locator('.mes_editor .cm-content').fill(`One edited twice ${s}`);
        expect((await edited).ok()).toBe(true);
        await page.locator('#chat .mes[mesid="0"] .mes_edit_done').click();

        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(`One edited twice ${s}`, { timeout: 10000 });
        await expect.poll(() => storedOpenings(page, avatar), { timeout: 10000 }).toEqual([
            { stored: false, mes: g[0] },
            { stored: false, mes: g[1] },
            { stored: true, mes: `One edited twice ${s}` },
            { stored: false, mes: g[2] },
        ]);
        expect(await notices(page)).not.toContain('Not saved');
        const now = await opening(page);
        expect(now.mes).toBe(`One edited twice ${s}`);
        expect(now.swipes).toEqual([g[0], g[1], `One edited twice ${s}`, g[2]]);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        const reloaded = await opening(page);
        expect(reloaded.node_id).toBe(now.node_id);
        expect(reloaded.swipes).toEqual([g[0], g[1], `One edited twice ${s}`, g[2]]);
    });

    test('what is typed while the edit\'s opening is being stored is saved too', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`];
        const avatar = await createCharacter(page, `TypedMeanwhile-${s}`, g);
        await openCharacter(page, avatar);
        await saveWhileTyping(page, true);
        /** @type {() => void} */
        let answer = () => {};
        const answered = new Promise(resolve => { answer = () => resolve(undefined); });
        let asked = false;
        await page.route('**/api/chats/message/select', async route => {
            asked = true;
            await answered;
            await route.continue();
        });

        await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
        await page.locator('.mes_editor .cm-content').fill(`Zero edited ${s}`);
        await expect.poll(() => asked, { timeout: 10000 }).toBe(true);
        await page.locator('.mes_editor .cm-content').fill(`Zero edited more ${s}`);
        await page.locator('#chat .mes[mesid="0"] .mes_edit_done').click();
        answer();

        await expect.poll(() => storedOpenings(page, avatar), { timeout: 10000 }).toEqual([
            { stored: false, mes: g[0] },
            { stored: true, mes: `Zero edited more ${s}` },
            { stored: false, mes: g[1] },
        ]);
        await expect.poll(async () => (await opening(page)).swipes, { timeout: 10000 }).toEqual([g[0], `Zero edited more ${s}`, g[1]]);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(`Zero edited more ${s}`);
    });

    test('an edit whose opening isn\'t stored shows the card greeting as it is, with a notice', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`];
        const avatar = await createCharacter(page, `EditRefused-${s}`, g);
        await openCharacter(page, avatar);
        await page.route('**/api/chats/message/select', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":true}' }));

        await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
        await page.locator('.mes_editor .cm-content').fill(`Zero edited ${s}`);
        await page.locator('#chat .mes[mesid="0"] .mes_edit_done').click();

        await expect.poll(() => notices(page), { timeout: 10000 }).toContain('Not saved');
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g[0]);
        const now = await opening(page);
        expect(now.mes).toBe(g[0]);
        expect(now.swipes).toEqual(g);
        expect(now.node_id.startsWith('card:')).toBe(true);
        expect(await storedOpenings(page, avatar)).toEqual([
            { stored: false, mes: g[0] },
            { stored: false, mes: g[1] },
        ]);
    });
});

test.describe('hiding messages that include a card greeting with no row', () => {
    test.beforeEach(testSetup.awaitST);

    test('/hide over the opening saves it as a stored opening that stays hidden after a reload', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`];
        const avatar = await createCharacter(page, `HideOpening-${s}`, g);
        await openCharacter(page, avatar);
        expect((await opening(page)).node_id.startsWith('card:')).toBe(true);

        await page.evaluate(async () => {
            // @ts-ignore
            await stTest.context().executeSlashCommandsWithOptions('/hide 0');
        });
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveAttribute('is_system', 'true');

        await expect.poll(() => storedOpenings(page, avatar), { timeout: 10000 }).toEqual([
            { stored: true, mes: g[0] },
            { stored: false, mes: g[1] },
        ]);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        const reloaded = await page.evaluate(() => {
            // @ts-ignore
            const m = stTest.context().chat[0];
            return { mes: m.mes, is_system: m.is_system, node_id: m.node_id };
        });
        expect(reloaded.mes).toBe(g[0]);
        expect(reloaded.is_system).toBe(true);
        expect(reloaded.node_id.startsWith('card:')).toBe(false);
    });
});

test.describe('editing the opening to a card greeting\'s text', () => {
    test.beforeEach(testSetup.awaitST);

    /**
     * @param {import('@playwright/test').Page} page
     * @param {string} text
     */
    async function editOpening(page, text) {
        await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
        await page.locator('.mes_editor .cm-content').fill(text);
        await page.locator('#chat .mes[mesid="0"] .mes_edit_done').click();
    }

    test('a greeting with macros, typed as the card has it, is that greeting: the chat shows it and nothing is stored', async ({ page }) => {
        const s = stamp();
        const g = [`Hi {{user}} ${s}`, `Bye {{char}} ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `DedupeMacro-${s}`, g);
        await openCharacter(page, avatar);
        await editOpening(page, g[1]);
        await expect.poll(async () => (await opening(page)).swipes, { timeout: 10000 }).toEqual(g);
        expect((await opening(page)).mes).toBe(g[1]);
        expect((await opening(page)).node_id.startsWith('card:')).toBe(true);
        expect(await storedOpenings(page, avatar)).toEqual([
            { stored: false, mes: g[0] },
            { stored: false, mes: g[1] },
            { stored: false, mes: g[2] },
        ]);
    });

    test('a stored opening edited to a card greeting\'s text becomes that greeting in the open chat too', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `DedupeStored-${s}`, g);
        await openCharacter(page, avatar);
        await editOpening(page, `Own ${s}`);
        await expect.poll(async () => (await opening(page)).swipes, { timeout: 10000 }).toEqual([g[0], `Own ${s}`, g[1], g[2]]);
        await editOpening(page, g[1]);
        await expect.poll(() => storedOpenings(page, avatar), { timeout: 10000 }).toEqual([
            { stored: false, mes: g[0] },
            { stored: true, mes: g[1] },
            { stored: false, mes: g[2] },
        ]);
        await expect.poll(async () => (await opening(page)).swipes, { timeout: 10000 }).toEqual([g[0], g[1], g[2]]);
        expect((await opening(page)).mes).toBe(g[1]);
    });
});
