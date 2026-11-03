import { test, expect } from './fixtures.js';
import { listEdit, openGreetingsList } from './alternatives-list.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';
import { cardToGreetingsModel } from '../../src/greeting-list.js';
import { hashGreetingText } from '../../src/greeting-ops.js';

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
 */
async function openingState(page) {
    return page.evaluate(() => {
        // @ts-ignore
        const chat = stTest.context().chat;
        const m = chat[0];
        return {
            length: chat.length,
            mes: m?.mes,
            node_id: m?.node_id,
            swipe_id: m?.swipe_id,
            swipes: m?.swipes ? [...m.swipes] : undefined,
        };
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} swipeId
 * @param {string} text
 */
async function showSwipe(page, swipeId, text) {
    await page.evaluate(async (swipeId) => {
        const { swipe } = await import('/script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        // @ts-ignore
        const current = stTest.context().chat[0].swipe_id ?? 0;
        const direction = swipeId > current ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
        await swipe(null, direction, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: swipeId });
    }, swipeId);
    await expect.poll(async () => (await openingState(page)).mes, { timeout: 10000 }).toBe(text);
    await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(text);
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * @param {import('@playwright/test').Browser} browser
 * @param {(other: import('@playwright/test').Page) => Promise<T>} fn
 * @template T
 */
async function withOtherSession(browser, fn) {
    const context = await browser.newContext();
    try {
        const other = await context.newPage();
        await testSetup.awaitST({ page: other });
        return await fn(other);
    } finally {
        await context.close();
    }
}

/**
 * @param {import('@playwright/test').Page} session
 * @param {string} avatar
 * @returns {Promise<string[]>}
 */
async function storedGreetings(session, avatar) {
    const card = await session.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        if (!response.ok) throw new Error(`get failed: ${response.status}`);
        return response.json();
    }, avatar);
    return cardToGreetingsModel(card).greetings;
}

/**
 * @param {import('@playwright/test').Page} session
 * @param {string} avatar
 * @param {string} text
 */
async function deleteGreetingViaApi(session, avatar, text) {
    const position = (await storedGreetings(session, avatar)).indexOf(text);
    expect(position).toBeGreaterThanOrEqual(0);
    const status = await session.evaluate(async ({ avatar, position, expectedHash }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/characters/greetings/delete', {
            method: 'POST',
            headers,
            body: JSON.stringify({ avatar_url: avatar, position, expected_hash: expectedHash }),
        });
        return response.status;
    }, { avatar, position, expectedHash: hashGreetingText(text) });
    expect(status).toBe(200);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Browser} browser
 * @param {object} args
 * @param {string} args.name
 * @param {string[]} args.greetings
 * @param {number} args.index
 * @param {string} args.text
 * @param {string[]} args.deleted
 */
async function editAcrossRemoteDeletes(page, browser, { name, greetings, index, text, deleted }) {
    const avatar = await createCharacter(page, name, greetings);
    await openCharacter(page, avatar);

    /** @type {string[]} */
    const editRequests = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/characters/greetings/edit') editRequests.push(request.postDataJSON().text);
    });

    await openInfoTab(page, 'greeting');
    const textarea = page.locator('#greeting_field');
    for (let i = 0; i < index; i++) await page.locator('.greeting-pager-next').click();
    await expect(page.locator('.greeting-pager-input')).toHaveValue(String(index + 1));
    await expect(textarea).toHaveValue(greetings[index]);
    await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
    await expect(textarea).toBeVisible();
    await textarea.fill(text);
    await expect(textarea).toHaveValue(text);

    return await withOtherSession(browser, async (other) => {
        for (const d of deleted) await deleteGreetingViaApi(other, avatar, d);
        const remaining = greetings.filter(g => !deleted.includes(g));
        expect(await storedGreetings(other, avatar)).toEqual(remaining);

        const refetched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/get', { timeout: 15000 });
        await page.evaluate(async (personality) => {
            // @ts-ignore
            const { executeSlashCommandsWithOptions } = stTest.context();
            await executeSlashCommandsWithOptions(`/char-update personality="${personality}"`);
        }, `Personality ${name}`);
        expect((await refetched).ok()).toBe(true);
        await expect(page.locator('.greeting-pager-total')).toHaveText(`/${greetings.length}`);
        await expect(page.locator('.greeting-pager-input')).toHaveValue(String(index + 1));
        await expect(textarea).toBeVisible();
        await expect(textarea).toHaveValue(text);
        expect(editRequests).toEqual([]);

        const editResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/greetings/edit', { timeout: 15000 });
        await page.locator('.field_edit_done[data-for="greeting_field"]').click();
        const response = await editResponse;
        expect(editRequests).toEqual([text]);
        const stored = await storedGreetings(other, avatar);
        if (response.ok()) {
            await expect(textarea).toBeHidden();
            await expect(page.locator('.greeting-pager-total')).toHaveText(`/${stored.length}`);
            await expect(page.locator('.greeting-pager-input')).toHaveValue(String(stored.indexOf(text) + 1));
            await expect(textarea).toHaveValue(text);
        }
        return { status: response.status(), stored, remaining };
    });
}

test.describe('editing the showing provisional greeting keeps it shown', () => {
    test.beforeEach(testSetup.awaitST);

    test('greetings list: editing the showing greeting keeps it shown, with its new text', async ({ page }) => {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `ProvTypeOn-${s}`, [g0, g1, g2]);
        await openCharacter(page, avatar);
        await showSwipe(page, 1, g1);
        expect((await openingState(page)).node_id.startsWith('card:')).toBe(true);

        await openGreetingsList(page, 3);
        const typed = `One edited ${s}`;
        await listEdit(page, 1, typed);

        await expect.poll(async () => (await openingState(page)).mes, { timeout: 10000 }).toBe(typed);
        const after = await openingState(page);
        expect(after.length).toBe(1);
        expect(after.swipe_id).toBe(1);
        expect(after.swipes).toEqual([g0, typed, g2]);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(typed);
    });

    test('greetings list: another session editing the same greeting again before the openings are read keeps that greeting shown, with the other session\'s text', async ({ page, browser }) => {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `ProvOtherReEdit-${s}`, [g0, g1, g2]);
        await openCharacter(page, avatar);
        await showSwipe(page, 1, g1);
        expect((await openingState(page)).node_id.startsWith('card:')).toBe(true);

        const typed = `One edited ${s}`;
        const otherText = `One edited elsewhere ${s}`;

        await withOtherSession(browser, async (other) => {
            let armed = false;
            let otherEdited = false;
            let otherStored = false;
            await page.route('**/api/ui/action', async (route) => {
                const response = await route.fetch();
                if (route.request().postDataJSON()?.type === 'alternatives.greeting') armed = true;
                await route.fulfill({ response });
            });
            await page.route('**/api/chats/openings', async (route) => {
                if (armed && !otherEdited) {
                    otherEdited = true;
                    const status = await other.evaluate(async ({ avatar, expectedHash, text }) => {
                        // @ts-ignore
                        const headers = stTest.context().getRequestHeaders();
                        const response = await fetch('/api/characters/greetings/edit', {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({ avatar_url: avatar, position: 1, expected_hash: expectedHash, text }),
                        });
                        return response.status;
                    }, { avatar, expectedHash: hashGreetingText(typed), text: otherText });
                    expect(status).toBe(200);
                    otherStored = true;
                }
                await route.continue();
            });

            await openGreetingsList(page, 3);
            await listEdit(page, 1, typed);

            await expect.poll(() => otherStored, { timeout: 10000 }).toBe(true);
            expect(await storedGreetings(other, avatar)).toEqual([g0, otherText, g2]);
        });

        await expect.poll(async () => (await openingState(page)).mes, { timeout: 10000 }).toBe(otherText);
        const after = await openingState(page);
        expect(after.length).toBe(1);
        expect(after.swipe_id).toBe(1);
        expect(after.swipes).toEqual([g0, otherText, g2]);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(otherText);
    });

    test('sidebar pager with auto-save on: confirming while the autosave is in flight keeps the same greeting shown with its new text', async ({ page }) => {
        const previousAutoSave = await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            const previous = power_user.auto_save_msg_edits;
            power_user.auto_save_msg_edits = true;
            return previous;
        });
        try {
            const s = stamp();
            const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
            const avatar = await createCharacter(page, `ProvPagerOverlap-${s}`, [g0, g1, g2]);
            await openCharacter(page, avatar);
            await showSwipe(page, 1, g1);
            expect((await openingState(page)).node_id.startsWith('card:')).toBe(true);

            /** @type {string[]} */
            const editTexts = [];
            /** @type {() => void} */
            let releaseFirst = () => {};
            const firstHeld = new Promise((resolveHeld) => {
                page.route('**/api/characters/greetings/edit', async (route) => {
                    editTexts.push(route.request().postDataJSON().text);
                    if (editTexts.length === 1) {
                        const response = await route.fetch();
                        const released = new Promise(resolve => { releaseFirst = () => resolve(undefined); });
                        resolveHeld(undefined);
                        await released;
                        await route.fulfill({ response });
                        return;
                    }
                    await route.continue();
                });
            });

            await openInfoTab(page, 'greeting');
            const textarea = page.locator('#greeting_field');
            await page.locator('.greeting-pager-next').click();
            await expect(page.locator('.greeting-pager-input')).toHaveValue('2');
            await expect(textarea).toHaveValue(g1);
            await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
            await expect(textarea).toBeVisible();

            const typed = `One edited ${s}`;
            const more = ' and more';
            const finalText = typed + more;

            const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/greetings/edit', { timeout: 15000 });
            await textarea.fill(typed);
            await firstHeld;
            expect(editTexts).toEqual([typed]);

            await textarea.press('End');
            await textarea.pressSequentially(more);
            await expect(textarea).toHaveValue(finalText);
            await page.locator('.field_edit_done[data-for="greeting_field"]').click();

            releaseFirst();
            expect((await firstResponse).ok()).toBe(true);

            await expect.poll(async () => (await openingState(page)).mes, { timeout: 10000 }).toBe(finalText);
            const after = await openingState(page);
            expect(after.length).toBe(1);
            expect(after.swipe_id).toBe(1);
            expect(after.swipes).toEqual([g0, finalText, g2]);
            await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(finalText);
        } finally {
            await page.evaluate(async (previous) => {
                const { power_user } = await import('/scripts/power-user.js');
                power_user.auto_save_msg_edits = previous;
            }, previousAutoSave);
        }
    });

    test('sidebar pager: editing g2 while g0 is deleted elsewhere and /char-update refreshes the card lands the edit on g2 at position 1', async ({ page, browser }) => {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const text = `Two edited ${s}`;
        const { stored } = await editAcrossRemoteDeletes(page, browser, { name: `ProvRemoteDel1-${s}`, greetings: [g0, g1, g2], index: 2, text, deleted: [g0] });
        expect(stored).toEqual([g1, text]);
    });

    test('sidebar pager: editing g2 while g2 itself is deleted elsewhere and /char-update refreshes the card is a 409 and changes nothing', async ({ page, browser }) => {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const text = `Two edited ${s}`;
        const { status, stored } = await editAcrossRemoteDeletes(page, browser, { name: `ProvRemoteDel2-${s}`, greetings: [g0, g1, g2], index: 2, text, deleted: [g2] });
        expect(status).toBe(409);
        expect(stored).toEqual([g0, g1]);
    });

    test('sidebar pager: editing g2 while g0 and g1 are deleted elsewhere and /char-update refreshes the card lands the edit at position 0 and leaves g3 untouched', async ({ page, browser }) => {
        const s = stamp();
        const [g0, g1, g2, g3] = [`Zero ${s}`, `One ${s}`, `Two ${s}`, `Three ${s}`];
        const text = `Two edited ${s}`;
        const { stored } = await editAcrossRemoteDeletes(page, browser, { name: `ProvRemoteDel3-${s}`, greetings: [g0, g1, g2, g3], index: 2, text, deleted: [g0, g1] });
        expect(stored[0]).toBe(text);
        expect(stored).toContain(g3);
    });
});
