import { test, expect } from './fixtures.js';
import { testSetup, openInfoTab, chatBox } from './frontent-test-utils.js';
import { openCharacter, startLlamaCpp, connectLlamaCpp } from './llamacpp-mock.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

test.beforeEach(testSetup.awaitST);

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings
 * @returns {Promise<string>}
 */
function createCharacter(page, name, greetings) {
    return page.evaluate(async ({ name, greetings }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', greetings[0]);
        for (const text of greetings.slice(1)) form.append('alternate_greetings', text);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return (await response.text()).trim();
    }, { name, greetings });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function usePersona(page, name) {
    await page.evaluate(async (name) => {
        // @ts-ignore
        const commands = stTest.context().SlashCommandParser.commands;
        const id = String(await commands['persona-create'].callback({ name, select: 'false' }));
        const { setUserAvatar } = await import('/scripts/personas.js');
        await setUserAvatar(id);
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} swipeId
 */
async function showGreeting(page, swipeId) {
    await page.evaluate(async (swipeId) => {
        const { swipe } = await import('/script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        // @ts-ignore
        const current = stTest.context().chat[0].swipe_id ?? 0;
        await swipe(null, swipeId > current ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: swipeId });
    }, swipeId);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} avatars
 */
async function openGroup(page, avatars) {
    await page.evaluate(async (members) => {
        // @ts-ignore
        const context = stTest.context();
        await context.getCharacters();
        const response = await fetch('/api/groups/create', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ name: 'Greeters', members }) });
        if (!response.ok) throw new Error(`group create failed: ${response.status}`);
        const { openGroupById } = await import('/scripts/group-chats.js');
        await openGroupById(String((await response.json()).id));
    }, avatars);
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} mesId
 */
const shown = (page, mesId) => page.locator(`#chat .mes[mesid="${mesId}"] .mes_text`);

test('a card greeting swiped to after a persona switch draws the persona now', async ({ page }) => {
    const s = stamp();
    const avatar = await createCharacter(page, `Greeter ${s}`, ['Hi {{user}}.', 'Bye {{user}}.']);
    await openCharacter(page, avatar);
    await usePersona(page, `Ann ${s}`);
    await expect(shown(page, 0)).toHaveText(`Hi Ann ${s}.`);
    await showGreeting(page, 1);
    await expect(shown(page, 0)).toHaveText(`Bye Ann ${s}.`);
});

test('a card greeting stored by sending under it keeps drawing the persona', async ({ page }) => {
    const mock = await startLlamaCpp({ reply: () => 'Hello {{user}}.' });
    try {
        await connectLlamaCpp(page, mock.url);
        const s = stamp();
        const avatar = await createCharacter(page, `Stored ${s}`, ['Hi {{user}}.', 'Bye {{user}}, from {{char}}.']);
        await openCharacter(page, avatar);
        await usePersona(page, `Bo ${s}`);
        await expect(shown(page, 0)).toHaveText(`Hi Bo ${s}.`);
        await showGreeting(page, 1);
        await chatBox(page).fill('Me, {{user}}.');
        await page.keyboard.press('Escape');
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes')).toHaveCount(3, { timeout: 15000 });
        await expect(shown(page, 0)).toHaveText(`Bye Bo ${s}, from Stored ${s}.`);
        await expect(shown(page, 1)).toHaveText(`Me, Bo ${s}.`);
        await expect(shown(page, 2)).toHaveText(`Hello Bo ${s}.`);
    } finally {
        await mock.close();
    }
});

test('the greeting\'s preview in the character\'s info draws the persona now', async ({ page }) => {
    const s = stamp();
    const avatar = await createCharacter(page, `Previewed ${s}`, ['Hi {{user}}, I am {{char}}.']);
    await openCharacter(page, avatar);
    await usePersona(page, `Cy ${s}`);
    await expect(shown(page, 0)).toHaveText(`Hi Cy ${s}, I am Previewed ${s}.`);
    await openInfoTab(page, 'greeting');
    await expect(page.locator('.field_preview[data-for="greeting_field"]')).toHaveText(`Hi Cy ${s}, I am Previewed ${s}.`);
});

test('each member\'s greeting in a group draws its member as {{char}} and the persona now', async ({ page }) => {
    const s = stamp();
    const ama = await createCharacter(page, `Ama ${s}`, ['I am {{char}}, hi {{user}}.']);
    const bea = await createCharacter(page, `Bea ${s}`, ['Me, {{char}}, greeting {{user}}.']);
    await openGroup(page, [ama, bea]);
    await usePersona(page, `Di ${s}`);
    await expect(shown(page, 0)).toHaveText(`I am Ama ${s}, hi Di ${s}.`);
    await showGreeting(page, 1);
    await expect(shown(page, 0)).toHaveText(`Me, Bea ${s}, greeting Di ${s}.`);
});

test('a macro in an HTML block is drawn as its value, as text', async ({ page }) => {
    const s = stamp();
    const avatar = await createCharacter(page, `Boxed ${s}`, ['<div class="box">Hi {{user}}, from <b>{{char}}</b>.</div>']);
    await usePersona(page, `<i>Ed</i> ${s}`);
    await openCharacter(page, avatar);
    const box = shown(page, 0).locator('div.custom-box');
    await expect(box).toHaveText(`Hi <i>Ed</i> ${s}, from Boxed ${s}.`);
    await expect(box.locator('b')).toHaveText(`Boxed ${s}`);
    await expect(box.locator('i')).toHaveCount(0);
});

test('a macro typed in a message stored with \\r\\n line breaks lands where it was typed, and Done with no edit keeps the text', async ({ page }) => {
    const s = stamp();
    const avatar = await createCharacter(page, `Lines ${s}`, ['Hello.']);
    await openCharacter(page, avatar);
    const written = 'One {{user}}.\r\nTwo {{char}}.\r\nThree.';
    await page.evaluate(async (written) => {
        // @ts-ignore
        await stTest.context().SlashCommandParser.commands['send'].callback({}, written);
    }, written);
    const mes = page.locator('#chat .mes[mesid="1"]');
    const stored = () => page.evaluate(() => {
        // @ts-ignore
        return stTest.context().chat[1].mes;
    });
    await expect(mes.locator('.mes_text')).toContainText('Three.');
    await mes.locator('.mes_edit').click();
    await expect(mes.locator('.cm-content')).toBeVisible();
    await mes.locator('.mes_edit_done').click();
    await expect(mes.locator('.cm-content')).toHaveCount(0);
    expect(await stored()).toBe(written);

    await mes.locator('.mes_edit').click();
    await mes.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Four {{char}}');
    await mes.locator('.mes_edit_done').click();
    await expect.poll(stored).toBe('One {{user}}.\nTwo {{char}}.\nThree. Four {{char}}');
    await expect(mes.locator('.mes_text')).toContainText(`Three. Four Lines ${s}`);
});
