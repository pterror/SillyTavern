import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const GREETINGS = ['Alpha greeting text', 'Bravo greeting text', 'Charlie greeting text', 'Delta greeting text'];

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>}
 */
async function createCharacter(page, name) {
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
    }, { name, greetings: GREETINGS });
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
    await expect.poll(() => page.evaluate((avatar) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        return context.characters[context.characterId]?.avatar === avatar && typeof context.chat[0]?.node_id === 'string';
    }, avatar), { timeout: 10000 }).toBe(true);
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
}

/**
 * Swipes message 0 to `swipeId` while sampling, every animation frame, what message 0 shows, where its block is
 * slid to, and how many messages are on screen.
 * @param {import('@playwright/test').Page} page
 * @param {number} swipeId
 * @param {number} [duration]
 * @returns {Promise<{text: string, tx: number, count: number}[]>}
 */
async function swipeSampled(page, swipeId, duration = 400) {
    return page.evaluate(async ({ swipeId, duration }) => {
        const { swipe } = await import('/script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        /** @type {{text: string, tx: number, count: number}[]} */
        const frames = [];
        let running = true;
        const sample = () => {
            const mes = document.querySelector('#chat .mes[mesid="0"]');
            const block = mes?.querySelector('.mes_block');
            const transform = block ? getComputedStyle(block).transform : 'none';
            const tx = transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m41 : 0;
            frames.push({
                text: mes?.querySelector('.mes_text')?.textContent?.trim() ?? '',
                tx,
                count: document.querySelectorAll('#chat .mes').length,
            });
            if (running) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        // @ts-ignore
        const current = SillyTavern.getContext().chat[0].swipe_id ?? 0;
        const direction = swipeId > current ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
        await swipe(null, direction, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: swipeId, forceDuration: duration });
        await new Promise(resolve => setTimeout(resolve, 100));
        running = false;
        return frames;
    }, { swipeId, duration });
}

/**
 * Splits sampled frames into the slide-out (block moving off towards `outSign`) and the slide-in (coming back from
 * the other side).
 * @param {{text: string, tx: number, count: number}[]} frames
 * @param {number} outSign -1 for a right swipe (slides left), 1 for a left swipe.
 */
function phases(frames, outSign) {
    const outFrames = [];
    const inFrames = [];
    let seenIn = false;
    for (const frame of frames) {
        if (Math.abs(frame.tx) < 2) continue;
        if (Math.sign(frame.tx) === outSign && !seenIn) outFrames.push(frame);
        else if (Math.sign(frame.tx) === -outSign) {
            seenIn = true;
            inFrames.push(frame);
        }
    }
    return { outFrames, inFrames };
}

test.describe('Swipe animation order', () => {
    test.beforeEach(testSetup.awaitST);

    test('a greeting swipe slides the old text out and the new text in', async ({ page }) => {
        const avatar = await createCharacter(page, `SwipeOrder ${Date.now()}`);
        await openCharacter(page, avatar);
        expect(await page.evaluate(() => {
            // @ts-ignore
            return SillyTavern.getContext().chat[0].mes;
        })).toBe(GREETINGS[0]);

        const frames = await swipeSampled(page, 1);
        const { outFrames, inFrames } = phases(frames, -1);
        expect(outFrames.length).toBeGreaterThan(0);
        expect(inFrames.length).toBeGreaterThan(0);
        expect(outFrames.every(f => f.text === GREETINGS[0])).toBe(true);
        expect(inFrames.every(f => f.text === GREETINGS[1])).toBe(true);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(GREETINGS[1]);
    });

    test('what follows the swiped message changes once, at the swap', async ({ page }) => {
        const avatar = await createCharacter(page, `SwipeOrderCont ${Date.now()}`);
        await openCharacter(page, avatar);
        // A user reply stores greeting 0 and hangs a message under it.
        await page.evaluate(async () => {
            // @ts-ignore
            await SillyTavern.getContext().executeSlashCommandsWithOptions('/send A reply under the first greeting');
        });
        await expect(page.locator('#chat .mes')).toHaveCount(2, { timeout: 10000 });
        await expect.poll(() => page.evaluate(() => {
            // @ts-ignore
            const chat = SillyTavern.getContext().chat;
            return chat.length === 2 && !String(chat[0].node_id).startsWith('card:') && typeof chat[1].node_id === 'string';
        }), { timeout: 10000 }).toBe(true);

        // Away from greeting 0: its reply stays on screen while sliding out, and is gone when sliding in.
        const away = phases(await swipeSampled(page, 1), -1);
        expect(away.outFrames.length).toBeGreaterThan(0);
        expect(away.inFrames.length).toBeGreaterThan(0);
        expect(away.outFrames.every(f => f.text === GREETINGS[0] && f.count === 2)).toBe(true);
        expect(away.inFrames.every(f => f.text === GREETINGS[1] && f.count === 1)).toBe(true);

        // Back to greeting 0 (stored): the reply comes back only with the new text.
        const back = phases(await swipeSampled(page, 0), 1);
        expect(back.outFrames.length).toBeGreaterThan(0);
        expect(back.inFrames.length).toBeGreaterThan(0);
        expect(back.outFrames.every(f => f.text === GREETINGS[1] && f.count === 1)).toBe(true);
        expect(back.inFrames.every(f => f.text === GREETINGS[0] && f.count === 2)).toBe(true);
        await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toHaveText('A reply under the first greeting');
        await expect(page.locator('#chat .mes.last_mes')).toHaveAttribute('mesid', '1');
    });

    test('fast repeated swipes and an overswipe end on the right text', async ({ page }) => {
        const avatar = await createCharacter(page, `SwipeOrderFast ${Date.now()}`);
        await openCharacter(page, avatar);
        for (const id of [1, 2, 3]) {
            await swipeSampled(page, id, 30);
        }
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(GREETINGS[3]);
        expect(await page.evaluate(() => {
            // @ts-ignore
            return SillyTavern.getContext().chat[0].mes;
        })).toBe(GREETINGS[3]);
        await expect(page.locator('#chat .mes.last_mes')).toHaveAttribute('mesid', '0');

        // Past the last greeting opens a fresh empty slot in the editor; cancelling it goes back to the last greeting.
        await page.evaluate(async () => {
            const { swipe } = await import('/script.js');
            const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
            await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceDuration: 30 });
        });
        await expect.poll(() => page.evaluate(() => {
            // @ts-ignore
            const message = SillyTavern.getContext().chat[0];
            return [message.swipe_id, message.mes];
        })).toEqual([GREETINGS.length, '']);
        await page.locator('#chat .mes[mesid="0"] .mes_edit_cancel').click();
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text:not(.cm-content)')).toHaveText(GREETINGS[3]);
    });
});
