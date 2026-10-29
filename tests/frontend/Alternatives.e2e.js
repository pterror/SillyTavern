import { devices } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';
import { cardToGreetingsModel } from '../../src/greeting-list.js';
import { hashGreetingText } from '../../src/greeting-ops.js';

// The alternatives of a message (packages/areas/alternatives): one list for a message's swipes and a character's
// greetings, every one rendered as the chat renders it; the server answers the list, the counts and the search.

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * Creates a character with these greetings (the first the default).
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings
 * @returns {Promise<string>} Its avatar.
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
        return (await response.text()).trim();
    }, { name, greetings });
}

/**
 * Opens the character's chat (and its editor) and waits for its first message.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {{ switchMenu?: boolean }} [options] `switchMenu`: the character's editor opens too (on a phone it covers the chat).
 */
async function openCharacter(page, avatar, { switchMenu = true } = {}) {
    await page.evaluate(async ({ avatar, switchMenu }) => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar, { switchMenu });
    }, { avatar, switchMenu });
    await expect.poll(() => page.evaluate(() => {
        // @ts-ignore
        return typeof SillyTavern.getContext().chat[0]?.node_id;
    }), { timeout: 15000 }).toBe('string');
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
}

/**
 * The character's greetings as the server stores them.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function storedModel(page, avatar) {
    const card = await page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        return response.json();
    }, avatar);
    return cardToGreetingsModel(card);
}

/**
 * The character's greetings as this page holds them.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function pageModel(page, avatar) {
    // @ts-ignore
    const card = await page.evaluate((avatar) => JSON.parse(JSON.stringify(SillyTavern.getContext().getCharacterByAvatar(avatar))), avatar);
    return cardToGreetingsModel(card);
}

/** @param {import('@playwright/test').Page} page */
const list = page => page.locator('dialog.alternatives');
/** @param {import('@playwright/test').Page} page */
const rows = page => list(page).locator('li.alternative:not(.alternatives-new)');
/** @param {import('@playwright/test').Page} page */
const shownRows = page => list(page).locator('li.alternative:not(.alternatives-new):not([hidden])');

/**
 * The chat goes to the opening's alternative #n.
 * @param {import('@playwright/test').Page} page
 * @param {number} n
 */
async function swipeGo(page, n) {
    await page.evaluate(async (n) => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions(`/swipe-go message=0 ${n}`);
    }, n);
}

/** @param {import('@playwright/test').Page} page */
const chatSwipe = (page, mesId = 0) => page.evaluate((mesId) => {
    // @ts-ignore
    const message = SillyTavern.getContext().chat[mesId];
    return { id: message.swipe_id ?? 0, text: message.mes };
}, mesId);

/**
 * A long greeting, as cards have them: paragraphs, emphasis, dialogue.
 * @param {number} i
 */
const longGreeting = i => [
    `*Greeting number ${i} begins as the morning fog lifts over the harbour.* The keeper looks up from the logbook.`,
    '"You came back," she says, setting down the pen. "I wasn\'t sure you would, after what happened at the lighthouse."',
    `The room smells of salt and old paper. Maps cover the walls; one of them, marked in red ink, shows a route that no ship has taken in a hundred years. ${'The wind keeps at the shutters while the kettle sings. '.repeat(8)}`,
    '**What do you do?**',
].join('\n\n');

test.describe('the alternatives of a message', () => {
    test.beforeEach(testSetup.awaitST);

    test('the counter opens the list on the current one, numbered, each rendered as the chat renders it; Go sends the chat there', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `Alt-${s}`, [`Hello *there* ${s}.`, `Second **bold** ${s}.`, `Third ${s}.`]);
        await openCharacter(page, avatar);
        await swipeGo(page, 3);
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(2);

        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(list(page)).toBeVisible();
        await expect(rows(page)).toHaveCount(3);
        await expect(list(page).locator('.alternatives-place')).toHaveText('#3 of 3');
        await expect(rows(page).nth(2)).toHaveClass(/current/);
        await expect(rows(page).nth(0).locator('.alternative-number')).toHaveText('#1');
        // Rendered: the markdown is the chat's.
        await expect(rows(page).nth(0).locator('.alternative-text em')).toHaveText('there');
        await expect(rows(page).nth(1).locator('.alternative-text strong')).toHaveText('bold');
        // Token counts come from the server.
        await expect(rows(page).nth(0).locator('.alternative-size')).toContainText(/\d+t/);

        // Go on a row: the chat shows it, and the list closes.
        await rows(page).nth(0).locator('.alternative-go').click();
        await expect(list(page)).toBeHidden();
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(0);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toContainText(`Hello there ${s}.`);
    });

    test('a number selects that one in the list; Go and Enter send the chat to the one selected', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `AltSelect-${s}`, Array.from({ length: 40 }, (_, i) => `Swipe ${i + 1} ${s}.`));
        await openCharacter(page, avatar);
        await swipeGo(page, 40);
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(39);

        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(40);
        const number = list(page).locator('.alternatives-select-n');
        await expect(number).toHaveValue('40');
        await number.fill('5');
        await expect(rows(page).nth(4)).toHaveClass(/selected/);
        await expect(rows(page).nth(4)).toBeInViewport();
        // Selecting isn't going: the chat still shows #40.
        expect((await chatSwipe(page)).id).toBe(39);
        await list(page).locator('form.alternatives-select .alternatives-go').click();
        await expect(list(page)).toBeHidden();
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(4);
        // Until the swipe is done, the chat says it can't change (Go says so too).
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isSwipingAllowed())).toBe(true);

        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(list(page).locator('.alternatives-place')).toHaveText('#5 of 40');
        await number.fill('12');
        await number.press('Enter');
        await expect(list(page)).toBeHidden();
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(11);
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isSwipingAllowed())).toBe(true);

        // The command does what Go does.
        await page.evaluate(async () => {
            // @ts-ignore
            await SillyTavern.getContext().executeSlashCommandsWithOptions('/swipe-go message=0 20');
        });
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(19);
    });

    test('search: the server matches, non-matches hide, matches are marked; clearing it scrolls back to the current one', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `AltSearch-${s}`, Array.from({ length: 60 }, (_, n) =>
            `Alternative ${n} ${s}.${n === 30 ? ' A red Lighthouse.' : n % 10 === 0 && n > 0 ? ' A lighthouse.' : ''}`));
        await openCharacter(page, avatar);
        await page.evaluate(async () => {
            // @ts-ignore
            await SillyTavern.getContext().executeSlashCommandsWithOptions('/swipe-go message=0 55');
        });
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(54);

        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(60);
        await expect(rows(page).nth(54)).toBeInViewport();
        const search = list(page).locator('.alternatives-search');
        await search.pressSequentially('lighth');
        // A prefix of the last word, as the chat search takes it.
        await expect(shownRows(page)).toHaveCount(5);
        await search.fill('red LIGHTHOUSE');
        await expect(shownRows(page)).toHaveCount(1);
        await expect(shownRows(page).first().locator('.alternative-number')).toHaveText('#31');
        const marks = shownRows(page).first().locator('mark.match');
        await expect(marks).toHaveText(['red', 'Lighthouse']);
        // Coloured by the theme variable, which custom CSS can set.
        await page.addStyleTag({ content: ':root { --match-color: rgb(1, 2, 3); }' });
        await expect(marks.first()).toHaveCSS('background-color', 'rgb(1, 2, 3)');
        await expect(list(page).locator('.alternatives-marker')).not.toHaveCount(0);
        // Rows the search hid keep what they drew: nothing is drawn again for them.
        await search.fill('no such words');
        await expect(shownRows(page)).toHaveCount(0);
        await expect(list(page)).toContainText('Nothing matches.');
        await search.fill('');
        await expect(shownRows(page)).toHaveCount(60);
        await expect(rows(page).nth(54)).toBeInViewport();
        await expect(list(page).locator('mark.match')).toHaveCount(0);
    });

    test('the counter shows on every message with more than one alternative, user messages too, and stays off one with one', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `AltCounter-${s}`, [`First ${s}.`, `Second ${s}.`]);
        await openCharacter(page, avatar);
        await page.evaluate(async (s) => {
            // @ts-ignore
            const context = SillyTavern.getContext();
            await context.executeSlashCommandsWithOptions(`/send Hi ${s}`);
            await context.executeSlashCommandsWithOptions(`/sendas name=Narrator One more ${s}`);
            // The user's message gets a second alternative (stored beside it), and the chat is read again.
            const { chatOpAddAlternative } = await import('/scripts/chat-store.js');
            await chatOpAddAlternative(1, `Hello ${s}`);
            const { reloadCurrentChat } = await import('/script.js');
            await reloadCurrentChat();
        }, s);
        await expect(page.locator('#chat .mes')).toHaveCount(3);
        // Not the last: the opening (two greetings) and the user's message (two) show it; a later one with one does.
        await expect(page.locator('#chat .mes[mesid="0"] .swipes-counter')).toBeVisible();
        await expect(page.locator('#chat .mes[mesid="1"] .swipes-counter')).toBeVisible();
        await expect(page.locator('#chat .mes[mesid="1"] .swipes-counter')).toHaveText('1/2');
        await page.locator('#chat .mes[mesid="1"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(2);
        await expect(rows(page).nth(0).locator('.alternative-text')).toContainText(`Hi ${s}`);
    });

    test('greetings: edit, reorder, set the default, remove one emptied; the card and the old page take each', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`, `Three ${s}`];
        const avatar = await createCharacter(page, `AltGreet-${s}`, g);
        await openCharacterManagementDrawer(page);
        await openCharacter(page, avatar);
        await openInfoTab(page, 'greeting');
        await page.locator('.open_alternate_greetings').click();
        await expect(rows(page)).toHaveCount(4);
        await expect(list(page).locator('.alternatives-title')).toHaveText('Greetings');

        // Edit.
        await rows(page).nth(1).locator('.alternative-edit').click();
        await rows(page).nth(1).locator('textarea').fill(`One *edited* ${s}`);
        await rows(page).nth(1).getByRole('button', { name: 'Save' }).click();
        await expect(rows(page).nth(1).locator('.alternative-text em')).toHaveText('edited');
        expect((await storedModel(page, avatar)).greetings).toEqual([g[0], `One *edited* ${s}`, g[2], g[3]]);
        await expect.poll(async () => (await pageModel(page, avatar)).greetings[1]).toBe(`One *edited* ${s}`);

        // Reorder by dragging Three's handle above Zero.
        const handle = rows(page).nth(3).locator('.alternative-drag');
        const target = await rows(page).nth(0).boundingBox();
        const from = await handle.boundingBox();
        if (!target || !from) throw new Error('no boxes');
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(target.x + 30, target.y + 5, { steps: 8 });
        await page.mouse.up();
        await expect(rows(page).nth(0).locator('.alternative-text')).toContainText(`Three ${s}`);
        expect((await storedModel(page, avatar)).greetings).toEqual([g[3], g[0], `One *edited* ${s}`, g[2]]);
        // A key moves it too.
        await rows(page).nth(0).locator('.alternative-drag').press('ArrowDown');
        await expect(rows(page).nth(1).locator('.alternative-text')).toContainText(`Three ${s}`);

        // The default.
        await rows(page).nth(3).locator('.alternative-default').click();
        await expect.poll(async () => (await storedModel(page, avatar)).defaultIndex).toBe(3);
        await expect(rows(page).nth(3)).toHaveClass(/current/);

        // An edit to nothing removes the greeting, once confirmed.
        await rows(page).nth(2).locator('.alternative-edit').click();
        await rows(page).nth(2).locator('textarea').fill('');
        await rows(page).nth(2).getByRole('button', { name: 'Save' }).click();
        await page.locator('dialog.popup:not(.alternatives) .popup-button-ok').click();
        await expect(rows(page)).toHaveCount(3);
        const stored = await storedModel(page, avatar);
        expect(stored.greetings).toHaveLength(3);
        await expect.poll(() => pageModel(page, avatar)).toEqual(stored);
        await expect(page.locator('.greeting-pager-total')).toHaveText('/3');

        // Add.
        await list(page).locator('.alternatives-add').click();
        await list(page).locator('.alternatives-new textarea').fill(`Four ${s}`);
        await list(page).locator('.alternatives-new').getByRole('button', { name: 'Save' }).click();
        await expect(rows(page)).toHaveCount(4);
        expect((await storedModel(page, avatar)).greetings[3]).toBe(`Four ${s}`);
    });

    test('an edit the server refuses (the greeting changed elsewhere) says why, and the typing stays in the editor', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `AltRefused-${s}`, [`Zero ${s}`, `One ${s}`]);
        await openCharacterManagementDrawer(page);
        await openCharacter(page, avatar);
        await openInfoTab(page, 'greeting');
        await page.locator('.open_alternate_greetings').click();
        await expect(rows(page)).toHaveCount(2);
        // The edit names the greeting by a hash it no longer has.
        await page.route('**/api/ui/action', async route => {
            const body = route.request().postDataJSON();
            if (body?.type !== 'alternatives.greeting') return route.continue();
            return route.continue({ postData: JSON.stringify({ ...body, payload: { ...body.payload, hash: 1 } }) });
        });
        await rows(page).nth(1).locator('.alternative-edit').click();
        await rows(page).nth(1).locator('textarea').fill(`One typed ${s}`);
        await rows(page).nth(1).getByRole('button', { name: 'Save' }).click();
        await expect(list(page).locator('.alternatives-notice')).not.toBeEmpty();
        await expect(rows(page).nth(1).locator('textarea')).toHaveValue(`One typed ${s}`);
        expect((await storedModel(page, avatar)).greetings).toEqual([`Zero ${s}`, `One ${s}`]);
    });

    test('operations on one card sent at once all land: the server runs them one after another', async ({ page }) => {
        const s = stamp();
        const g = Array.from({ length: 6 }, (_, i) => `G${i} ${s}`);
        const avatar = await createCharacter(page, `AltQueue-${s}`, g);
        await openCharacter(page, avatar);
        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(6);
        const answers = await page.evaluate(async ({ g, s }) => {
            const { getStringHash } = await import('/scripts/utils.js');
            const hash = (/** @type {string} */ text) => getStringHash(JSON.stringify(text));
            // @ts-ignore
            const headers = { ...SillyTavern.getContext().getRequestHeaders(), 'Content-Type': 'application/json' };
            // An answer is JSON, or NDJSON whose first line is the answer.
            const send = (/** @type {object} */ payload) => fetch('/api/ui/action', { method: 'POST', headers, body: JSON.stringify({ type: 'alternatives.greeting', payload }) })
                .then(r => r.text())
                .then(text => JSON.parse(text.split('\n')[0]));
            return Promise.all(g.map((text, position) => send({ op: 'edit', position, hash: hash(text), text: `${text} edited ${s}` })));
        }, { g, s });
        expect(answers.map(a => a.ok)).toEqual(g.map(() => true));
        expect((await storedModel(page, avatar)).greetings).toEqual(g.map(text => `${text} edited ${s}`));
    });

    test('the list opened from the first message\'s counter has the card\'s controls on the card\'s greetings: edit, default, reorder, add, delete', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `AltOpeningCard-${s}`, g);
        await openCharacter(page, avatar);
        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(3);
        for (const control of ['.alternative-edit', '.alternative-default', '.alternative-drag', '.alternative-delete-greeting']) {
            await expect(rows(page).nth(1).locator(control)).toHaveCount(1);
        }
        await expect(list(page).locator('.alternatives-add')).toBeVisible();

        await rows(page).nth(1).locator('.alternative-edit').click();
        await rows(page).nth(1).locator('textarea').fill(`One edited ${s}`);
        await rows(page).nth(1).getByRole('button', { name: 'Save' }).click();
        await expect.poll(async () => (await storedModel(page, avatar)).greetings).toEqual([g[0], `One edited ${s}`, g[2]]);
        await expect(list(page).locator('li.alternative .alternative-text')).toContainText([g[0], `One edited ${s}`, g[2]]);

        await rows(page).nth(2).locator('.alternative-default').click();
        await expect.poll(async () => (await storedModel(page, avatar)).defaultIndex).toBe(2);

        await rows(page).nth(0).locator('.alternative-drag').press('End');
        await expect.poll(async () => (await storedModel(page, avatar)).greetings).toEqual([`One edited ${s}`, g[2], g[0]]);

        await list(page).locator('.alternatives-add').click();
        await list(page).locator('.alternatives-new textarea').fill(`Three ${s}`);
        await list(page).locator('.alternatives-new').getByRole('button', { name: 'Save' }).click();
        await expect.poll(async () => (await storedModel(page, avatar)).greetings).toHaveLength(4);

        await list(page).locator('li.alternative', { hasText: `Three ${s}` }).locator('.alternative-delete-greeting').click();
        await page.locator('dialog.popup:not(.alternatives) .popup-button-ok').click();
        await expect.poll(async () => (await storedModel(page, avatar)).greetings).toEqual([`One edited ${s}`, g[2], g[0]]);
        // The old page's character took each change.
        await expect.poll(async () => (await pageModel(page, avatar)).greetings).toEqual([`One edited ${s}`, g[2], g[0]]);
    });

    test('a swipe added to a greeting no chat has stored is stored as its own opening: the greeting stays the card\'s, it survives a reload, and editing the greeting leaves no duplicate', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`];
        const avatar = await createCharacter(page, `AltAddSwipe-${s}`, g);
        await openCharacter(page, avatar);
        const added = `Added ${s}`;
        await page.evaluate(async (text) => {
            // @ts-ignore
            await SillyTavern.getContext().SlashCommandParser.commands['addswipe'].callback({ quiet: 'true' }, text);
        }, added);
        /** The chat's openings as the server lists them. */
        const openings = () => page.evaluate(async (avatar) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            const response = await fetch('/api/chats/openings', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, offset: 0, limit: 100 }) });
            const answer = await response.json();
            return { stored: answer.stored, texts: answer.alternatives.map((/** @type {any} */ a) => a.mes) };
        }, avatar);
        // Only the added swipe is stored: no stored copy of the card's greeting.
        await expect.poll(openings).toEqual({ stored: 1, texts: [added, g[0], g[1]] });

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect.poll(() => page.evaluate(() => {
            // @ts-ignore
            return [...SillyTavern.getContext().chat[0].swipes];
        })).toContain(added);

        const status = await page.evaluate(async ({ avatar, text, hash }) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            const response = await fetch('/api/characters/greetings/edit', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, position: 0, expected_hash: hash, text }) });
            return response.status;
        }, { avatar, text: `Zero edited ${s}`, hash: hashGreetingText(g[0]) });
        expect(status).toBe(200);
        expect(await openings()).toEqual({ stored: 1, texts: [added, `Zero edited ${s}`, g[1]] });
    });

    test('a greeting is shown in the chat from the list when that character\'s chat is open; otherwise it says why not', async ({ page }) => {
        const s = stamp();
        const g = [`Morning ${s}.`, `Evening ${s}.`, `Night ${s}.`];
        const avatar = await createCharacter(page, `AltShow-${s}`, g);
        await openCharacterManagementDrawer(page);
        await openCharacter(page, avatar);
        await openInfoTab(page, 'greeting');
        await page.locator('.open_alternate_greetings').click();
        await expect(rows(page)).toHaveCount(3);
        await rows(page).nth(2).locator('.alternative-go').click();
        await expect(list(page)).toBeHidden();
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toContainText(`Night ${s}.`);

        // Another character's chat: the greeting can't be shown, and the list says why.
        const other = await createCharacter(page, `AltOther-${s}`, [`Other ${s}.`]);
        await openCharacter(page, other);
        await page.evaluate(async (avatar) => {
            const { newUi } = await import('/scripts/new-ui-page.js');
            newUi().alternatives.openGreetings(avatar, 'x');
        }, avatar);
        await expect(rows(page)).toHaveCount(3);
        const go = rows(page).nth(1).locator('.alternative-go');
        await expect(go).toHaveAttribute('aria-disabled', 'true');
        await go.dispatchEvent('click');
        await expect(list(page).locator('.alternatives-notice')).toContainText('Open a chat with this character');
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toContainText(`Other ${s}.`);
    });

    test('opened again after a reload, the list shows at once from what this browser kept, then the server\'s', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `AltKept-${s}`, [`A ${s}.`, `B ${s}.`]);
        await openCharacter(page, avatar);
        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(2);
        await page.keyboard.press('Escape');
        await expect.poll(() => page.evaluate(() => new Promise((resolve) => {
            const request = indexedDB.open('st-alternatives');
            request.onsuccess = () => {
                const all = request.result.transaction('seen').objectStore('seen').getAll();
                all.onsuccess = () => resolve(all.result.length);
            };
        }))).toBeGreaterThan(0);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        // The server's answer is held back: the list is there before it, from what was kept.
        /** @type {() => void} */
        let release = () => {};
        const held = new Promise(resolve => { release = () => resolve(undefined); });
        await page.route('**/api/ui/action', async route => {
            if (route.request().postDataJSON()?.type === 'alternatives.open') await held;
            await route.continue();
        });
        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(2);
        await expect(rows(page).nth(1).locator('.alternative-text')).toContainText(`B ${s}.`);
        release();
    });

    test('with IndexedDB failing, the list still opens and works', async ({ page }) => {
        await page.addInitScript(() => {
            // @ts-ignore
            indexedDB.open = () => { throw new Error('blocked'); };
        });
        await page.reload();
        await testSetup.awaitST({ page });
        const s = stamp();
        const avatar = await createCharacter(page, `AltNoDb-${s}`, [`A ${s}.`, `B ${s}.`]);
        await openCharacter(page, avatar);
        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(2);
        await page.keyboard.press('Escape');
        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(2);
    });

    test('opened again, the list shows at once from what it last saw, then the server\'s', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `AltCache-${s}`, [`A ${s}.`, `B ${s}.`]);
        await openCharacter(page, avatar);
        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(2);
        await page.keyboard.press('Escape');
        await expect(list(page)).toBeHidden();
        // The server's answer is held back: the list is there before it.
        /** @type {() => void} */
        let release = () => {};
        const held = new Promise(resolve => { release = () => resolve(undefined); });
        await page.route('**/api/ui/action', async route => {
            if (route.request().postDataJSON()?.type === 'alternatives.open') await held;
            await route.continue();
        });
        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(2);
        await expect(rows(page).nth(1).locator('.alternative-text')).toContainText(`B ${s}.`);
        release();
    });
});

test.describe('on a phone', () => {
    // The project's browser stays; only the phone's viewport, touch and user agent are taken.
    const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['Pixel 7'];
    test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });
    test.beforeEach(testSetup.awaitST);

    test('a tap on the counter opens the list, and its controls are big enough for a finger', async ({ page }) => {
        const s = stamp();
        await createCharacter(page, `AltTap-${s}`, [`First ${s}.`, `Second ${s}.`]);
        await page.evaluate(async (name) => {
            // @ts-ignore
            await SillyTavern.getContext().getCharacters();
            // @ts-ignore
            await SillyTavern.getContext().executeSlashCommandsWithOptions(`/go ${name}`);
        }, `AltTap-${s}`);
        await expect(page.locator('#chat .mes[mesid="0"]')).toContainText(`First ${s}.`, { timeout: 15000 });
        // On a phone the character's panel opens over the chat with it: it's closed, as the user would.
        const editor = page.locator('#charInfoHolder > .drawer-toggle .drawer-icon');
        if (await page.locator('div#delete_button').isVisible()) await editor.tap();
        await expect(page.locator('div#delete_button')).toBeHidden();
        const counter = page.locator('#chat .mes[mesid="0"] .swipes-counter');
        await expect(counter).toHaveClass(/swipe-picker-enabled/);
        await counter.tap();
        await expect(list(page)).toBeVisible();
        await expect(rows(page)).toHaveCount(2);
        const go = await rows(page).nth(0).locator('.alternative-go').boundingBox();
        expect(go?.height).toBeGreaterThanOrEqual(44);
        await rows(page).nth(1).locator('.alternative-go').tap();
        await expect(list(page)).toBeHidden();
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(1);
    });

    /**
     * How long, in the page, a click on the counter takes to show the current alternative drawn (formatted), how many
     * rows are there then, and how long until every row is, under a phone's CPU (throttled).
     * @param {import('@playwright/test').Page} page
     * @param {number} count
     */
    async function timeOpen(page, count) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        try {
            return await page.evaluate(async (count) => {
                const start = performance.now();
                /** @type {HTMLElement} */ (document.querySelector('#chat .mes[mesid="0"] .swipes-counter')).click();
                /** @type {{ current: number, rowsThen: number, all: number }} */
                const times = { current: 0, rowsThen: 0, all: 0 };
                // Sampled each frame: when the current one is drawn (formatted) and how many rows there are then,
                // and when every row is there.
                await new Promise((resolve) => {
                    const check = () => {
                        const rows = document.querySelectorAll('dialog.alternatives li.alternative').length;
                        const current = document.querySelector('dialog.alternatives li.alternative.current .alternative-text');
                        if (!times.current && current?.firstElementChild) {
                            times.current = performance.now() - start;
                            times.rowsThen = rows;
                        }
                        if (times.current && rows === count) {
                            times.all = performance.now() - start;
                            resolve(undefined);
                        } else {
                            requestAnimationFrame(check);
                        }
                    };
                    check();
                });
                return times;
            }, count);
        } finally {
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        }
    }

    /**
     * How long a search takes to show its first match and to be done, and whether it said it was still searching on
     * the way, under the throttled CPU.
     * @param {import('@playwright/test').Page} page
     * @param {string} query
     * @param {number} matching
     */
    async function timeSearch(page, query, matching) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        try {
            return await page.evaluate(async ({ query, matching }) => {
                const input = /** @type {HTMLInputElement} */ (document.querySelector('dialog.alternatives .alternatives-search'));
                const start = performance.now();
                input.value = query;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                /** @type {{ first: number, done: number, sawSearching: boolean }} */
                const times = { first: 0, done: 0, sawSearching: false };
                // Sampled each frame: the first match shown, whether it said it was still searching, and when it's done.
                await new Promise((resolve) => {
                    const check = () => {
                        const shown = document.querySelectorAll('dialog.alternatives li.alternative:not([hidden])').length;
                        const status = document.querySelector('dialog.alternatives .alternatives-found')?.textContent ?? '';
                        if (status.startsWith('Searching')) times.sawSearching = true;
                        if (!times.first && shown > 0 && shown <= matching) times.first = performance.now() - start;
                        if (shown === matching && status !== '' && !status.startsWith('Searching')) {
                            times.done = performance.now() - start;
                            resolve(undefined);
                        } else {
                            requestAnimationFrame(check);
                        }
                    };
                    check();
                });
                return times;
            }, { query, matching });
        } finally {
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        }
    }

    // Budgets on a phone's CPU (4x throttled): the current alternative drawn within CURRENT_MS; every row of 1,000 long
    // greetings within OPEN_1000_MS, of 3,000 (stored openings and the card's greetings) within OPEN_3000_MS; a search
    // answered within SEARCH_MS. Both first opens (nothing seen before) and opening again (what was seen shows at once).
    const CURRENT_MS = 1000;
    const OPEN_1000_MS = 2000;
    const OPEN_3000_MS = 4500;
    const SEARCH_MS = 500;
    const SEARCH_3000_MS = 2000;

    test('1,000 long greetings open and draw within the budget, and a search answers within its own', async ({ page }) => {
        test.setTimeout(240000);
        const s = stamp();
        const greetings = Array.from({ length: 1000 }, (_, i) => longGreeting(i) + (i === 700 ? ` A beacon ${s}.` : ''));
        const avatar = await createCharacter(page, `AltBudget-${s}`, greetings);
        await openCharacter(page, avatar, { switchMenu: false });
        await expect(page.locator('#chat .mes[mesid="0"] .swipes-counter')).toContainText('/1000', { timeout: 30000 });
        const answered = page.waitForResponse(r => r.request().postDataJSON()?.type === 'alternatives.open');
        const open = await timeOpen(page, 1000);
        // The answer streams (NDJSON): the rows around the current one first, then all of them.
        const answer = await answered;
        expect(answer.headers()['content-type']).toContain('application/x-ndjson');
        const lines = (await answer.text()).trim().split('\n').map(line => JSON.parse(line));
        const listOf = (/** @type {any} */ line) => line.views.find((/** @type {any} */ v) => v.key === 'alternatives.list').value;
        const first = listOf(lines[0]);
        expect(first.complete).toBe(false);
        expect(first.items.length).toBeLessThan(1000);
        expect(first.items.map((/** @type {any} */ i) => i.index)).toContain(first.current);
        expect(listOf(lines.at(-1)).items).toHaveLength(1000);
        const search = await timeSearch(page, `beacon ${s}`, 1);
        console.log(`[budget] 1000 greetings: current drawn ${Math.round(open.current)} ms (with ${open.rowsThen} rows), all ${Math.round(open.all)} ms, search first ${Math.round(search.first)} ms, done ${Math.round(search.done)} ms (CPU 4x)`);
        expect(open.current).toBeLessThan(CURRENT_MS);
        expect(open.all).toBeLessThan(OPEN_1000_MS);
        expect(search.done).toBeLessThan(SEARCH_MS);
    });

    test('3,000 alternatives (stored openings and card greetings) open and draw within the budget', async ({ page }) => {
        test.setTimeout(300000);
        const s = stamp();
        const greetings = Array.from({ length: 1000 }, (_, i) => longGreeting(i));
        const avatar = await createCharacter(page, `AltBudget3k-${s}`, greetings);
        // 2,000 stored openings: a chat whose first message has that many swipes, imported.
        const opened = await page.evaluate(async ({ avatar, s }) => {
            // @ts-ignore
            const context = SillyTavern.getContext();
            const swipes = Array.from({ length: 2000 }, (_, i) => `Stored opening ${i} ${s}. *It was a quiet night.* "Hello," says the keeper. ${'The tide comes in slowly, wave over wave. '.repeat(20)}`);
            const header = { user_name: 'User', character_name: 'Keeper', chat_metadata: {} };
            const first = { name: 'Keeper', is_user: false, send_date: Date.now(), mes: swipes[0], swipes, swipe_id: 0, swipe_info: swipes.map(() => ({ send_date: Date.now(), extra: {} })) };
            const file = new File([`${JSON.stringify(header)}\n${JSON.stringify(first)}`], 'opening.jsonl');
            const form = new FormData();
            form.set('avatar', file);
            form.set('file_type', 'jsonl');
            form.set('avatar_url', avatar);
            form.set('character_name', 'Keeper');
            form.set('user_name', 'User');
            const response = await fetch('/api/chats/import', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
            return response.json();
        }, { avatar, s });
        expect(opened.fileNames).toHaveLength(1);
        await openCharacter(page, avatar, { switchMenu: false });
        await page.evaluate(async (file) => {
            const { openCharacterChat } = await import('/script.js');
            await openCharacterChat(file.replace(/\.jsonl$/, ''));
        }, opened.fileNames[0]);
        await expect(page.locator('#chat .mes[mesid="0"] .swipes-counter')).toContainText('/3000', { timeout: 60000 });
        const open = await timeOpen(page, 3000);
        await page.keyboard.press('Escape');
        await expect(list(page)).toBeHidden();
        const reopen = await timeOpen(page, 3000);
        // A match among the last: the search streams what each step found and how far it is.
        const searched = page.waitForResponse(r => r.request().postDataJSON()?.type === 'alternatives.search');
        const search = await timeSearch(page, `Stored opening 1999 ${s}`, 1);
        const steps = (await (await searched).text()).trim().split('\n').map(line => JSON.parse(line).views.find((/** @type {any} */ v) => v.key === 'alternatives.matches'));
        const checked = steps.map((/** @type {any} */ v) => (v.value ?? v.patch).checked);
        expect(checked.length).toBeGreaterThan(1);
        expect(checked).toEqual([...checked].sort((a, b) => a - b));
        expect(checked.at(-1)).toBe(3000);
        console.log(`[budget] 3000 alternatives: search first ${Math.round(search.first)} ms, done ${Math.round(search.done)} ms, in ${steps.length} parts, said it was searching while drawn: ${search.sawSearching} (CPU 4x)`);
        expect(search.done).toBeLessThan(SEARCH_3000_MS);
        console.log(`[budget] 3000 alternatives: current drawn ${Math.round(open.current)} ms (with ${open.rowsThen} rows), all ${Math.round(open.all)} ms; open again: current ${Math.round(reopen.current)} ms, all ${Math.round(reopen.all)} ms (CPU 4x)`);
        // Streamed: the current one is drawn before the rest of the list is there.
        expect(open.rowsThen).toBeLessThan(3000);
        expect(open.current).toBeLessThan(CURRENT_MS);
        expect(open.all).toBeLessThan(OPEN_3000_MS);
        // Opened again, the list seen before is there at once.
        expect(reopen.current).toBeLessThan(CURRENT_MS);
        expect(reopen.all).toBeLessThan(OPEN_3000_MS);
    });
});
