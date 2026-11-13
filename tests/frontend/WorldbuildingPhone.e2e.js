import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { deleteWorld, makeWorld } from './worlds.js';

const PHONE = { width: 390, height: 844 };

const ENTRIES = {
    0: { uid: 0, key: ['The Lantern House'], keysecondary: [], comment: 'The Lantern House', content: 'The inn at the top of the stairs.', displayIndex: 0, extensions: { names: ['The Lantern House'] } },
    1: { uid: 1, key: ['Ilse Varro', 'ledger'], keysecondary: [], comment: 'Ilse Varro', content: 'Ilse keeps the Lantern House and its ledger.', displayIndex: 1, extensions: { names: ['Ilse Varro'], relations: [{ kind: 1, target: 0, position: 'a' }] } },
};

/** @param {string} stamp */
const bookOf = (stamp) => `Phone-${stamp}`;

test.describe('the worlds page on a phone', () => {
    test.beforeEach(testSetup.awaitST);

    test('a tapped name in the chat brings its card up from the bottom, and Open opens the entry', async ({ page }) => {
        test.setTimeout(120_000);
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const book = bookOf(stamp);
        await makeWorld(page, book, ENTRIES, { relationKinds: [{ id: 1, name: 'in' }] });
        await page.locator('#WIDrawerIcon').click();
        const avatar = await page.evaluate(async ({ name, book }) => {
            // @ts-ignore
            const context = stTest.context();
            const form = new FormData();
            form.set('ch_name', name);
            form.set('first_mes', 'Hello.');
            const created = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
            if (!created.ok) throw new Error(`create failed: ${created.status}`);
            await context.executeSlashCommandsWithOptions(`/world silent=true ${book}`);
            await context.getCharacters();
            const avatar = await created.text();
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
            return avatar;
        }, { name: `Teller-${stamp}`, book });
        try {
            await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
            await page.evaluate(async () => {
                // @ts-ignore
                await stTest.context().executeSlashCommandsWithOptions('/send We go to Ilse Varro.');
            });
            const link = page.locator('#chat .mes[mesid="1"] .mes_text .chat-name');
            await expect(link).toHaveCount(1, { timeout: 15000 });
            await page.setViewportSize(PHONE);
            await page.evaluate(() => document.querySelector('#charInfoHolder:has(#char-info-panel.openDrawer) #charInfoDrawerIcon')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
            await expect(page.locator('#char-info-panel')).not.toHaveClass(/openDrawer/);
            await link.click();
            const sheet = page.locator('.wb-chat-sheet');
            await expect(sheet).toBeVisible();
            await expect(sheet.locator('.wb-chat-sheet-name')).toHaveText('Ilse Varro');
            await expect(sheet.locator('.wb-chat-sheet-path')).toHaveText('in: The Lantern House');
            await expect(sheet.locator('.wb-chat-sheet-text')).toHaveText('Ilse keeps the Lantern House and its ledger.');
            await expect.poll(async () => {
                const box = await sheet.boundingBox();
                return Math.round((box?.y ?? 0) + (box?.height ?? 0));
            }).toBe(PHONE.height);
            await expect(page.locator('#Worldbuilding')).toBeHidden();

            await page.locator('.wb-chat-scrim').click({ position: { x: 20, y: 20 } });
            await expect(sheet).toBeHidden();
            await link.click();
            await sheet.getByRole('button', { name: 'Open' }).click();
            await expect(sheet).toBeHidden();
            await expect(page.locator('#Worldbuilding .wb-entry .wb-entry-name')).toContainText('Ilse Varro', { timeout: 10000 });
        } finally {
            await page.setViewportSize({ width: 1280, height: 820 });
            await page.evaluate(async (avatar) => {
                // @ts-ignore
                const headers = stTest.context().getRequestHeaders();
                await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
            }, avatar);
            await deleteWorld(page, book);
        }
    });

    test('the world is one column of cards; an entry opens over it, with its own bar, and the back arrow goes back', async ({ page }) => {
        test.setTimeout(90_000);
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const book = bookOf(stamp);
        await makeWorld(page, book, ENTRIES, { relationKinds: [{ id: 1, name: 'in' }] });
        try {
            await page.setViewportSize(PHONE);
            const pane = page.locator('#Worldbuilding');
            const region = pane.locator('.wb-region', { hasText: 'The Lantern House' });
            await expect(region).toBeVisible();
            const card = region.locator('.wb-card', { hasText: 'Ilse Varro' });
            const [regionBox, cardBox] = [await region.boundingBox(), await card.boundingBox()];
            expect(cardBox?.width).toBeGreaterThan((regionBox?.width ?? 0) - 40);
            await expect(pane.getByRole('button', { name: 'New entry' })).toBeVisible();
            await expect.poll(async () => (await pane.locator('.wb-head .wb-search input').boundingBox())?.width).toBeLessThan(2);

            await card.locator('.wb-card-open').click();
            const entry = pane.locator('.wb-entry');
            await expect(entry.locator('.wb-entry-name')).toContainText('Ilse Varro');
            await expect(pane.locator('.wb-head')).toBeHidden();
            await expect(entry.locator('.wb-phone-rels')).toHaveText('in: The Lantern House');
            await expect(entry.locator('.wb-rels')).toBeHidden();

            await entry.getByRole('button', { name: 'Back to the world' }).click();
            await expect(pane.locator('.wb-entry')).toHaveCount(0);
            await expect(pane.locator('.wb-head')).toBeVisible();
            await expect(region).toBeVisible();
        } finally {
            await page.setViewportSize({ width: 1280, height: 820 });
            await deleteWorld(page, book);
        }
    });
});
