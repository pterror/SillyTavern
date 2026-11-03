import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';
import { cardToGreetingsModel } from '../../src/greeting-list.js';

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
async function storedModel(page, avatar) {
    const card = await page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        if (!response.ok) throw new Error(`get failed: ${response.status}`);
        return response.json();
    }, avatar);
    return cardToGreetingsModel(card);
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} nestedText
 * @param {string} outerText
 * @returns {Promise<{outer: string, nested: string}>}
 */
async function saveWithNestedListenerSave(page, nestedText, outerText) {
    return page.evaluate(async ({ nestedText, outerText }) => {
        const limitMs = 10000;
        const { saveGreetingField } = await import('/script.js');
        // @ts-ignore
        const { eventSource, eventTypes } = stTest.context();
        const timedOut = () => new Promise(resolve => setTimeout(() => resolve('hung'), limitMs));
        /** @type {Promise<any>|null} */
        let nested = null;
        const listener = async () => {
            if (nested) return;
            nested = saveGreetingField(nestedText);
            await nested;
        };
        eventSource.on(eventTypes.CHARACTER_EDITED, listener);
        try {
            const outerSave = saveGreetingField(outerText);
            const outerResult = await Promise.race([outerSave.then(() => 'done'), timedOut()]);
            const nestedResult = nested ? await Promise.race([nested.then(() => 'done'), timedOut()]) : 'never started';
            return { outer: outerResult, nested: nestedResult };
        } finally {
            eventSource.removeListener(eventTypes.CHARACTER_EDITED, listener);
        }
    }, { nestedText, outerText });
}

test.describe('a greeting save started from inside CHARACTER_EDITED', () => {
    test.beforeEach(testSetup.awaitST);

    test('from a pager save\'s event, both saves finish and the nested one lands last', async ({ page }) => {
        const s = stamp();
        const [g0, g1] = [`Zero ${s}`, `One ${s}`];
        const [outerText, nestedText] = [`Zero outer ${s}`, `Zero nested ${s}`];
        const avatar = await createCharacter(page, `NestedPager-${s}`, [g0, g1]);
        await openCharacter(page, avatar);

        expect(await saveWithNestedListenerSave(page, nestedText, outerText)).toEqual({ outer: 'done', nested: 'done' });
        expect(await storedModel(page, avatar)).toEqual({ greetings: [nestedText, g1], defaultIndex: 0 });
    });

});

