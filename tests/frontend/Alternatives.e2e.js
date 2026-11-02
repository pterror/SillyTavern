import { devices } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';
import { cardToGreetingsModel } from '../../src/greeting-list.js';
import { hashGreetingText } from '../../src/greeting-ops.js';

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings
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
        return (await response.text()).trim();
    }, { name, greetings });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {{ switchMenu?: boolean }} [options]
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
const rows = page => list(page).locator('li.alternative');
/** @param {import('@playwright/test').Page} page */
const shownRows = page => list(page).locator('li.alternative:visible');

/**
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
        await expect(rows(page).nth(0).locator('.alternative-text em')).toHaveText('there');
        await expect(rows(page).nth(1).locator('.alternative-text strong')).toHaveText('bold');
        await expect(rows(page).nth(0).locator('.alternative-size')).toContainText(/\d+t/);

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
        expect((await chatSwipe(page)).id).toBe(39);
        await list(page).locator('form.alternatives-select .alternatives-go').click();
        await expect(list(page)).toBeHidden();
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(4);
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isSwipingAllowed())).toBe(true);

        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(list(page).locator('.alternatives-place')).toHaveText('#5 of 40');
        await number.fill('12');
        await number.press('Enter');
        await expect(list(page)).toBeHidden();
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(11);
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isSwipingAllowed())).toBe(true);

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
        await expect(shownRows(page)).toHaveCount(5);
        await search.fill('red LIGHTHOUSE');
        await expect(shownRows(page)).toHaveCount(1);
        await expect(shownRows(page).first().locator('.alternative-number')).toHaveText('#31');
        const marks = shownRows(page).first().locator('mark.match');
        await expect(marks).toHaveText(['red', 'Lighthouse']);
        await page.addStyleTag({ content: ':root { --match-color: rgb(1, 2, 3); }' });
        await expect(marks.first()).toHaveCSS('background-color', 'rgb(1, 2, 3)');
        await expect(list(page).locator('.alternatives-marker')).not.toHaveCount(0);
        await search.fill('no such words');
        await expect(shownRows(page)).toHaveCount(0);
        await expect(list(page)).toContainText('Nothing matches.');
        await search.fill('');
        await expect(shownRows(page)).toHaveCount(60);
        await expect(rows(page).nth(54)).toBeInViewport();
        await expect(list(page).locator('mark.match')).toHaveCount(0);
    });

    test('opened on one near the end, the current one is centred on the first frame it is shown and never moves while the rest draws', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `AltPlace-${s}`, Array.from({ length: 60 }, (_, n) => n % 3 === 0 ? longGreeting(n) : `Short ${n} ${s}.`));
        await openCharacter(page, avatar);
        await swipeGo(page, 56);
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(55);
        await page.evaluate(() => {
            /** @type {{ t: number, offset: number, centre: number }[]} */
            const samples = [];
            // @ts-ignore
            window.placeSamples = samples;
            const t0 = performance.now();
            const sample = () => {
                const scroller = document.querySelector('dialog.alternatives .alternatives-list');
                const row = scroller?.querySelector('li.alternative.current');
                if (scroller && row) {
                    const box = scroller.getBoundingClientRect();
                    const at = row.getBoundingClientRect();
                    samples.push({
                        t: performance.now() - t0,
                        offset: at.top - box.top,
                        centre: at.top + at.height / 2 - (box.top + scroller.clientHeight / 2),
                    });
                }
                if (performance.now() - t0 < 3000) requestAnimationFrame(sample);
                // @ts-ignore
                else window.placeDone = true;
            };
            requestAnimationFrame(sample);
        });
        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        // @ts-ignore
        await expect.poll(() => page.evaluate(() => window.placeDone), { timeout: 10000 }).toBe(true);
        /** @type {{ t: number, offset: number, centre: number }[]} */
        // @ts-ignore
        const samples = await page.evaluate(() => window.placeSamples);
        expect(samples.length).toBeGreaterThan(10);
        expect(Math.abs(samples[0].centre)).toBeLessThanOrEqual(1);
        expect(samples.filter(x => Math.abs(x.offset - samples[0].offset) > 0.5)).toEqual([]);
    });

    test('the counter shows on every message, user messages too, dimmed on an earlier one with one alternative', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `AltCounter-${s}`, [`First ${s}.`, `Second ${s}.`]);
        await openCharacter(page, avatar);
        await page.evaluate(async (s) => {
            // @ts-ignore
            const context = SillyTavern.getContext();
            await context.executeSlashCommandsWithOptions(`/send Hi ${s}`);
            await context.executeSlashCommandsWithOptions(`/sendas name=Narrator One more ${s}`);
            await context.executeSlashCommandsWithOptions(`/sendas name=Narrator Last ${s}`);
            const { chatOpAddAlternative } = await import('/scripts/chat-store.js');
            await chatOpAddAlternative(1, `Hello ${s}`);
            const { reloadCurrentChat } = await import('/script.js');
            await reloadCurrentChat();
        }, s);
        await expect(page.locator('#chat .mes')).toHaveCount(4);
        await expect(page.locator('#chat .mes[mesid="0"] .swipes-counter')).toBeVisible();
        await expect(page.locator('#chat .mes[mesid="1"] .swipes-counter')).toBeVisible();
        await expect(page.locator('#chat .mes[mesid="1"] .swipes-counter')).toHaveText('1/2');
        const single = page.locator('#chat .mes[mesid="2"] .swipes-counter');
        await expect(single).toBeVisible();
        await expect(single).toHaveText('1​/​1');
        const opacity = (/** @type {number} */ mesId) => page.locator(`#chat .mes[mesid="${mesId}"] .swipes-counter`)
            .evaluate(el => Number(getComputedStyle(el).opacity));
        await expect.poll(async () => (await opacity(2)) < (await opacity(1))).toBe(true);
        await page.locator('#chat .mes[mesid="1"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(2);
        await expect(rows(page).nth(0).locator('.alternative-text')).toContainText(`Hi ${s}`);
        await rows(page).nth(0).locator('.alternative-text').dblclick();
        await expect(list(page).locator('textarea')).toHaveCount(0);
    });

    test('a greeting\'s text edits on a double-click, and on a click when click to edit is on, at the word clicked; a link opens instead', async ({ page }) => {
        const s = stamp();
        const g = [`Alpha bravo charlie ${s}.`, `Read [the guide](https://example.com/guide) first ${s}.`];
        const avatar = await createCharacter(page, `AltClickEdit-${s}`, g);
        await openCharacter(page, avatar);
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.click_to_edit = false;
            document.addEventListener('click', event => {
                if (/** @type {Element} */ (event.target).closest('a[href]')) event.preventDefault();
            }, true);
        });
        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(2);
        const text = rows(page).nth(0).locator('.alternative-text');
        const editor = rows(page).nth(0).locator('textarea');
        const charlie = await text.evaluate(el => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const at = node.textContent?.indexOf('charlie') ?? -1;
                if (at < 0) continue;
                const range = document.createRange();
                range.setStart(node, at + 2);
                range.setEnd(node, at + 3);
                const box = range.getBoundingClientRect();
                return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            }
            throw new Error('no charlie');
        });
        const start = g[0].indexOf('charlie');

        await page.mouse.click(charlie.x, charlie.y);
        await expect(editor).toHaveCount(0);
        await page.mouse.dblclick(charlie.x, charlie.y);
        await expect(editor).toBeFocused();
        let caret = await editor.evaluate(el => /** @type {HTMLTextAreaElement} */ (el).selectionStart);
        expect(caret).toBeGreaterThanOrEqual(start);
        expect(caret).toBeLessThanOrEqual(start + 'charlie'.length);
        await rows(page).nth(0).getByRole('button', { name: 'Cancel' }).click();

        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.click_to_edit = true;
        });
        await page.mouse.click(charlie.x, charlie.y);
        await expect(editor).toBeFocused();
        caret = await editor.evaluate(el => /** @type {HTMLTextAreaElement} */ (el).selectionStart);
        expect(caret).toBeGreaterThanOrEqual(start);
        expect(caret).toBeLessThanOrEqual(start + 'charlie'.length);
        await rows(page).nth(0).getByRole('button', { name: 'Cancel' }).click();

        await rows(page).nth(1).locator('.alternative-text a[href]').click();
        await expect(rows(page).nth(1).locator('textarea')).toHaveCount(0);
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

        await rows(page).nth(1).locator('.alternative-edit').click();
        await rows(page).nth(1).locator('textarea').fill(`One *edited* ${s}`);
        await rows(page).nth(1).getByRole('button', { name: 'Save' }).click();
        await expect(rows(page).nth(1).locator('.alternative-text em')).toHaveText('edited');
        expect((await storedModel(page, avatar)).greetings).toEqual([g[0], `One *edited* ${s}`, g[2], g[3]]);
        await expect.poll(async () => (await pageModel(page, avatar)).greetings[1]).toBe(`One *edited* ${s}`);

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
        await rows(page).nth(0).locator('.alternative-drag').press('ArrowDown');
        await expect(rows(page).nth(1).locator('.alternative-text')).toContainText(`Three ${s}`);

        await rows(page).nth(3).locator('.alternative-default').click();
        await expect.poll(async () => (await storedModel(page, avatar)).defaultIndex).toBe(3);
        await expect(rows(page).nth(3)).toHaveClass(/current/);

        await rows(page).nth(2).locator('.alternative-edit').click();
        await rows(page).nth(2).locator('textarea').fill('');
        await rows(page).nth(2).getByRole('button', { name: 'Save' }).click();
        await page.locator('dialog.popup:not(.alternatives) .popup-button-ok').click();
        await expect(rows(page)).toHaveCount(3);
        const stored = await storedModel(page, avatar);
        expect(stored.greetings).toHaveLength(3);
        await expect.poll(() => pageModel(page, avatar)).toEqual(stored);
        await expect(page.locator('.greeting-pager-total')).toHaveText('/3');

        await list(page).locator('.alternatives-add textarea').fill(`Four ${s}`);
        await list(page).locator('.alternatives-add').getByRole('button', { name: 'Add' }).click();
        await expect(rows(page)).toHaveCount(4);
        expect((await storedModel(page, avatar)).greetings[3]).toBe(`Four ${s}`);
    });

    test('the greetings list is the chat\'s width, counts its greetings when none is the default, and adds one from the box at its bottom without moving the list or setting off the page\'s Ctrl+Enter', async ({ page }) => {
        const s = stamp();
        const one = await createCharacter(page, `AltOne-${s}`, [`Only ${s}`]);
        const avatar = await createCharacter(page, `AltBox-${s}`, Array.from({ length: 12 }, (_, i) => longGreeting(i)));
        await openCharacterManagementDrawer(page);
        await openCharacter(page, one);
        await openInfoTab(page, 'greeting');
        await page.locator('.open_alternate_greetings').click();
        await expect(rows(page)).toHaveCount(1);
        await expect(list(page).locator('.alternatives-place')).toHaveText('#1 of 1');
        await rows(page).nth(0).locator('.alternative-default').click();
        await expect(list(page).locator('.alternatives-place')).toHaveText('1 greeting');
        await list(page).locator('.alternatives-close').click();
        await expect(list(page)).toBeHidden();

        await openCharacter(page, avatar);
        await openInfoTab(page, 'greeting');
        await page.locator('.open_alternate_greetings').click();
        await expect(rows(page)).toHaveCount(12);
        await rows(page).nth(0).locator('.alternative-default').click();
        await expect(list(page).locator('.alternatives-place')).toHaveText('12 greetings');
        expect(await list(page).locator('.alternatives-list').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
        const width = async (/** @type {string} */ selector) => (await page.locator(selector).boundingBox())?.width;
        expect(await width('dialog.alternatives')).toBeCloseTo(/** @type {number} */ (await width('#sheld')), 0);

        const box = list(page).locator('.alternatives-add textarea');
        const add = list(page).locator('.alternatives-add').getByRole('button', { name: 'Add' });
        await expect(add).toBeDisabled();
        const scrolled = () => list(page).locator('.alternatives-list').evaluate(el => el.scrollTop);
        expect(await scrolled()).toBe(0);
        await box.fill(`Ctrl ${s}`);
        await box.press('Control+Enter');
        await expect(rows(page)).toHaveCount(13);
        await expect(box).toHaveValue('');
        expect(await scrolled()).toBe(0);
        await expect(page.locator('dialog.popup')).toHaveCount(0);
        await box.fill(`Button ${s}`);
        await add.click();
        await expect(rows(page)).toHaveCount(14);
        await expect(box).toHaveValue('');
        await expect(list(page).locator('.alternatives-place')).toHaveText('14 greetings');
        expect((await storedModel(page, avatar)).greetings.slice(12)).toEqual([`Ctrl ${s}`, `Button ${s}`]);

        await box.fill(`Dropped ${s}`);
        await box.press('Escape');
        await expect(box).toHaveValue('');
        await expect(list(page)).toBeVisible();
        await box.press('Escape');
        await expect(list(page)).toBeHidden();
    });

    test('an edit the server refuses (the greeting changed elsewhere) says why, and the typing stays in the editor', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `AltRefused-${s}`, [`Zero ${s}`, `One ${s}`]);
        await openCharacterManagementDrawer(page);
        await openCharacter(page, avatar);
        await openInfoTab(page, 'greeting');
        await page.locator('.open_alternate_greetings').click();
        await expect(rows(page)).toHaveCount(2);
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
        const notIcons = await list(page).evaluate(dialog => [...dialog.querySelectorAll('[class*="fa-"]')]
            .filter(el => !getComputedStyle(el, '::before').fontFamily.includes('Font Awesome'))
            .map(el => el.className));
        expect(notIcons).toEqual([]);

        await rows(page).nth(1).locator('.alternative-edit').click();
        await rows(page).nth(1).locator('textarea').fill(`One edited ${s}`);
        await rows(page).nth(1).getByRole('button', { name: 'Save' }).click();
        await expect.poll(async () => (await storedModel(page, avatar)).greetings).toEqual([g[0], `One edited ${s}`, g[2]]);
        await expect(list(page).locator('li.alternative .alternative-text')).toContainText([g[0], `One edited ${s}`, g[2]]);

        await rows(page).nth(2).locator('.alternative-default').click();
        await expect.poll(async () => (await storedModel(page, avatar)).defaultIndex).toBe(2);

        await rows(page).nth(0).locator('.alternative-drag').press('End');
        await expect.poll(async () => (await storedModel(page, avatar)).greetings).toEqual([`One edited ${s}`, g[2], g[0]]);

        await list(page).locator('.alternatives-add textarea').fill(`Three ${s}`);
        await list(page).locator('.alternatives-add textarea').press('Control+Enter');
        await expect.poll(async () => (await storedModel(page, avatar)).greetings).toHaveLength(4);

        await list(page).locator('li.alternative', { hasText: `Three ${s}` }).locator('.alternative-delete-greeting').click();
        await page.locator('dialog.popup:not(.alternatives) .popup-button-ok').click();
        await expect.poll(async () => (await storedModel(page, avatar)).greetings).toEqual([`One edited ${s}`, g[2], g[0]]);
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
        const openings = () => page.evaluate(async (avatar) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            const response = await fetch('/api/chats/openings', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, offset: 0, limit: 100 }) });
            const answer = await response.json();
            return { stored: answer.stored, texts: answer.alternatives.map((/** @type {any} */ a) => a.mes) };
        }, avatar);
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
        const editor = page.locator('#charInfoHolder > .drawer-toggle .drawer-icon');
        if (await page.locator('div#delete_button').isVisible()) await editor.tap();
        await expect(page.locator('div#delete_button')).toBeHidden();
        const counter = page.locator('#chat .mes[mesid="0"] .swipes-counter');
        await expect(counter).toHaveClass(/swipe-picker-enabled/);
        await counter.tap();
        await expect(list(page)).toBeVisible();
        await expect(rows(page)).toHaveCount(2);
        const dialog = /** @type {{ x: number, width: number }} */ (await list(page).boundingBox());
        expect(dialog.x).toBeGreaterThanOrEqual(16);
        expect(dialog.x + dialog.width).toBeLessThanOrEqual(viewport.width - 16);
        const go = await rows(page).nth(0).locator('.alternative-go').boundingBox();
        expect(go?.height).toBeGreaterThanOrEqual(44);
        await rows(page).nth(1).locator('.alternative-go').tap();
        await expect(list(page)).toBeHidden();
        await expect.poll(async () => (await chatSwipe(page)).id).toBe(1);
    });

    /**
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
                await new Promise((resolve) => {
                    const check = () => {
                        const rows = document.querySelectorAll('dialog.alternatives li.alternative').length;
                        const current = document.querySelector('dialog.alternatives li.alternative.current .alternative-text');
                        if (!times.current && current?.firstElementChild) {
                            times.current = performance.now() - start;
                            times.rowsThen = rows;
                        }
                        if (times.current && rows === count) {
                            requestAnimationFrame(() => requestAnimationFrame(() => {
                                times.all = performance.now() - start;
                                resolve(undefined);
                            }));
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
                await new Promise((resolve) => {
                    const check = () => {
                        const filtering = document.querySelector('dialog.alternatives .alternatives-list.filtering');
                        const shown = document.querySelectorAll(`dialog.alternatives li.alternative${filtering ? '.matched' : ''}`).length;
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

    const CURRENT_MS = 1000;
    const OPEN_1000_MS = 3000;
    const OPEN_3000_MS = 8000;
    const SEARCH_MS = 1000;
    const SEARCH_3000_MS = 3000;

    test('1,000 long greetings open and draw within the budget, and a search answers within its own', async ({ page }) => {
        test.setTimeout(240000);
        const s = stamp();
        const greetings = Array.from({ length: 1000 }, (_, i) => longGreeting(i) + (i === 700 ? ` A beacon ${s}.` : ''));
        const avatar = await createCharacter(page, `AltBudget-${s}`, greetings);
        await openCharacter(page, avatar, { switchMenu: false });
        await expect(page.locator('#chat .mes[mesid="0"] .swipes-counter')).toContainText('/1000', { timeout: 30000 });
        const answered = page.waitForResponse(r => r.request().postDataJSON()?.type === 'alternatives.open');
        const open = await timeOpen(page, 1000);
        const answer = await answered;
        expect(answer.headers()['content-type']).toContain('application/x-ndjson');
        const lines = (await answer.text()).trim().split('\n').map(line => JSON.parse(line));
        const parts = lines.map(line => line.views.find((/** @type {any} */ v) => v.key === 'alternatives.list')?.value).filter(Boolean);
        const first = parts[0];
        expect(first.complete).toBe(false);
        expect(first.items.length).toBeLessThan(1000);
        expect(first.items.map((/** @type {any} */ i) => i.index)).toContain(first.current);
        expect(parts.map((/** @type {any} */ p) => p.items.length)).toEqual([...parts.map((/** @type {any} */ p) => p.items.length)].sort((a, b) => a - b));
        expect(parts.at(-1).items).toHaveLength(1000);
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
        expect(open.rowsThen).toBeLessThan(3000);
        expect(open.current).toBeLessThan(CURRENT_MS);
        expect(open.all).toBeLessThan(OPEN_3000_MS);
        expect(reopen.current).toBeLessThan(CURRENT_MS);
        expect(reopen.all).toBeLessThan(OPEN_3000_MS);
    });
});
