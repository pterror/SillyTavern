import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';
import { cardToGreetingsModel } from '../../src/greeting-list.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings The first is the default.
 * @returns {Promise<string>}
 */
async function createCharacter(page, name, greetings) {
    return page.evaluate(async ({ name, greetings }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
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
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
}

/**
 * The character's greetings and default as the server stores them.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function storedModel(page, avatar) {
    const card = await page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        if (!response.ok) throw new Error(`get failed: ${response.status}`);
        return response.json();
    }, avatar);
    return cardToGreetingsModel(card);
}

/**
 * Writes the field the way an extension written for upstream does.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} values Written one after another in the same task.
 */
async function writeFirstMessage(page, ...values) {
    await page.evaluate((values) => {
        for (const value of values) {
            // @ts-ignore
            $('#firstmessage_textarea').val(value).trigger('input');
        }
    }, values);
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('#firstmessage_textarea, upstream\'s first message field', () => {
    test.beforeEach(testSetup.awaitST);

    test('reads the default greeting, and a write saves it as upstream\'s first message', async ({ page }) => {
        const s = stamp();
        const [alpha, bravo] = [`Alpha ${s}`, `Bravo ${s}`];
        const avatar = await createCharacter(page, `FirstMes-${s}`, [alpha, bravo]);
        await openCharacter(page, avatar);
        const field = page.locator('#firstmessage_textarea');
        await expect(field).toHaveValue(alpha);

        const edited = `Alpha edited ${s}`;
        await writeFirstMessage(page, edited);
        await expect.poll(() => storedModel(page, avatar), { timeout: 10000 }).toEqual({ greetings: [edited, bravo], defaultIndex: 0 });
        await expect(page.locator('#greeting_field')).toHaveValue(edited);

        await writeFirstMessage(page, '');
        await expect.poll(() => storedModel(page, avatar), { timeout: 10000 }).toEqual({ greetings: [edited, bravo], defaultIndex: null });
        await expect(field).toHaveValue('');

        const charlie = `Charlie ${s}`;
        await writeFirstMessage(page, charlie);
        await expect.poll(() => storedModel(page, avatar), { timeout: 10000 }).toEqual({ greetings: [edited, bravo, charlie], defaultIndex: 2 });
        await expect(field).toHaveValue(charlie);
    });

    test('writes in quick succession end on the last one', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `FirstMesQuick-${s}`, [`Alpha ${s}`, `Bravo ${s}`]);
        await openCharacter(page, avatar);

        const edits = [];
        page.on('request', request => {
            if (new URL(request.url()).pathname === '/api/characters/greetings/edit') edits.push(request);
        });
        await writeFirstMessage(page, `One ${s}`, `Two ${s}`, `Three ${s}`);
        await expect.poll(() => storedModel(page, avatar), { timeout: 10000 }).toEqual({ greetings: [`Three ${s}`, `Bravo ${s}`], defaultIndex: 0 });
        expect(edits.length).toBeLessThanOrEqual(2);
        await expect(page.locator('#firstmessage_textarea')).toHaveValue(`Three ${s}`);
    });

    test('follows a default changed elsewhere on the page', async ({ page }) => {
        const s = stamp();
        const [alpha, bravo] = [`Alpha ${s}`, `Bravo ${s}`];
        const avatar = await createCharacter(page, `FirstMesFollow-${s}`, [alpha, bravo]);
        await openCharacter(page, avatar);
        await page.evaluate(async () => {
            const { saveGreetingField } = await import('/script.js');
            await saveGreetingField('Alpha changed');
        });
        await expect(page.locator('#firstmessage_textarea')).toHaveValue('Alpha changed');
    });
});
