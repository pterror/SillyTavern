import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, setStackedDrawers, chatBox } from './frontent-test-utils.js';
import { deleteWorld, makeWorld } from './worlds.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['stTest'].context();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

const settle = (/** @type {import('@playwright/test').Page} */ page) => page.waitForTimeout(700);

/**
 * Opens the Author's Note, a drawer the user moves anywhere, without touching the chat, and puts it at `box`; the
 * stack hears it moved as it hears a drag
 * @param {import('@playwright/test').Page} page
 * @param {{ left: number, top: number, width: number, height: number }} box
 */
async function authorsNoteAt(page, box) {
    await page.evaluate(() => { $('#option_toggle_AN').trigger('click'); });
    const note = page.locator('#floatingPrompt');
    await expect(note).toBeVisible();
    await expect(note).not.toHaveClass(/resizing/);
    await page.evaluate(async (box) => {
        const note = document.getElementById('floatingPrompt');
        Object.assign(note.style, {
            left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
            right: 'auto', bottom: 'auto', margin: 'unset', maxWidth: 'none', maxHeight: 'none',
        });
        const { drawerStackChanged } = await import('/scripts/drawer-stack.js');
        drawerStackChanged();
    }, box);
    await settle(page);
}

/**
 * Where a surface shows over its painted part, against a drawer over it: away from the drawer's edges, it must show
 * where the drawer doesn't cover it and nowhere the drawer does
 * @param {import('@playwright/test').Page} page
 * @param {{ surface: string, painted: string, cover: string }} selectors
 * @returns {Promise<{ under: number, beside: number, wrong: string[] }>}
 */
function clipping(page, { surface, painted, cover }) {
    return page.evaluate(({ surface, painted, cover }) => {
        const shown = document.querySelector(surface);
        const part = document.querySelector(painted).getBoundingClientRect();
        const over = document.querySelector(cover).getBoundingClientRect();
        let under = 0;
        let beside = 0;
        const wrong = [];
        for (let x = part.left + 4; x < part.right - 4; x += 8) {
            for (let y = part.top + 4; y < part.bottom - 4; y += 8) {
                const fromEdge = Math.min(Math.abs(x - over.left), Math.abs(x - over.right), Math.abs(y - over.top), Math.abs(y - over.bottom));
                if (fromEdge < 14) continue;
                const covered = x > over.left && x < over.right && y > over.top && y < over.bottom;
                const shows = shown.contains(document.elementFromPoint(x, y));
                if (covered) under++; else beside++;
                if (shows === covered) wrong.push(`${Math.round(x)},${Math.round(y)}: ${covered ? 'shows under the drawer' : 'cut where nothing covers it'}`);
            }
        }
        return { under, beside, wrong: wrong.slice(0, 5) };
    }, { surface, painted, cover });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} book the world the chat reads, used in every chat
 * @returns {Promise<string>} the character's avatar
 */
async function characterReading(page, name, book) {
    return page.evaluate(async ({ name, book }) => {
        // @ts-ignore
        const context = stTest.context();
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello.');
        const created = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        if (!created.ok) throw new Error(`create failed: ${created.status}`);
        await context.executeSlashCommandsWithOptions(`/world silent=true ${book}`);
        await context.getCharacters();
        return created.text();
    }, { name, book });
}

test.describe('a surface belongs to the panel it was opened from', () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await loadApp(page);
        await setStackedDrawers(page, true);
    });

    test('a word\'s card over the chat is cut where a drawer stacked over the chat covers it', async ({ page }) => {
        test.setTimeout(120_000);
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const book = `Cut-${stamp}`;
        const entry = { uid: 0, key: ['Ilse Varro'], keysecondary: [], comment: 'Ilse Varro', content: 'Ilse keeps the Lantern House and its ledger.', extensions: { names: ['Ilse Varro'] } };
        await makeWorld(page, book, { 0: entry });
        await page.locator('#WIDrawerIcon').click();
        await expect(page.locator('#Worldbuilding')).not.toBeVisible();
        const avatar = await characterReading(page, `Teller-${stamp}`, book);
        try {
            await page.evaluate(async (avatar) => {
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
            await page.evaluate(async () => {
                // @ts-ignore
                await stTest.context().executeSlashCommandsWithOptions('/send We go to Ilse Varro.');
            });
            const link = page.locator('#chat .mes[mesid="1"] .mes_text .chat-name');
            await expect(link).toHaveCount(1, { timeout: 15000 });

            await link.hover();
            const card = page.locator('.wb-chat-card');
            await expect(card).toBeVisible();
            const shown = await card.boundingBox();
            const word = await link.boundingBox();
            await page.mouse.move(700, 880);
            await expect(card).toBeHidden();

            const left = shown.x + shown.width / 2;
            const top = Math.max(shown.y - 20, word.y + word.height + 2);
            await authorsNoteAt(page, { left, top, width: 500, height: 400 });
            expect(await page.evaluate(async () => {
                const { drawerOrder } = await import('/scripts/drawer-stack.js');
                return drawerOrder(document.getElementById('floatingPrompt')) > drawerOrder(document.getElementById('sheld'));
            })).toBe(true);

            await link.hover();
            await expect(card).toBeVisible();
            await settle(page);
            await expect(page.locator('.wb-chat-card-at')).toHaveAttribute('data-stack-cut', 'true');
            await expect(page.locator('.wb-chat-card-at')).not.toHaveClass(/stackCovered/);
            const seen = await clipping(page, { surface: '.wb-chat-card-at', painted: '.wb-chat-card', cover: '#floatingPrompt' });
            expect(seen.wrong).toEqual([]);
            expect(seen.under).toBeGreaterThan(0);
            expect(seen.beside).toBeGreaterThan(0);
        } finally {
            await page.evaluate(async (avatar) => {
                // @ts-ignore
                const headers = stTest.context().getRequestHeaders();
                await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
            }, avatar);
            await deleteWorld(page, book);
        }
    });

    test('the chat box\'s suggestions are cut where a drawer stacked over the chat covers them', async ({ page }) => {
        await openCharacterManagementDrawer(page);
        await page.locator('.character_select', { hasText: 'Alice' }).first().click();
        await expect(page.locator('#chatDrawerIcon')).toHaveClass(/stackFront/);
        await chatBox(page).click();
        await page.keyboard.type('/');
        const list = page.locator('#chat_box .cm-tooltip-autocomplete');
        await expect(list).toBeVisible();
        await settle(page);
        const shown = await list.boundingBox();
        const box = await page.locator('#chat_box').boundingBox();

        const bottom = Math.min(shown.y + shown.height, box.y - 2);
        await authorsNoteAt(page, { left: shown.x + shown.width / 2, top: shown.y - 40, width: 500, height: bottom - shown.y + 40 });
        await expect(list).toBeVisible();
        const seen = await clipping(page, { surface: '#chat_box .cm-tooltip-autocomplete', painted: '#chat_box .cm-tooltip-autocomplete', cover: '#floatingPrompt' });
        expect(seen.wrong).toEqual([]);
        expect(seen.under).toBeGreaterThan(0);
        expect(seen.beside).toBeGreaterThan(0);
    });
});
