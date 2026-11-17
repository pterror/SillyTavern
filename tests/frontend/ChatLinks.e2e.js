import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { deleteWorld, makeWorld } from './worlds.js';

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

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openChatOf(page, avatar) {
    await page.evaluate(async (avatar) => {
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
}

test('a name of an entry written in a message is drawn in its look and linked; pointing at it shows its card, a click opens it', async ({ page }) => {
    test.setTimeout(120_000);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const book = `Linked-${stamp}`;
    await testSetup.awaitST({ page });
    const entry = { uid: 0, key: ['Ilse Varro', 'ledger'], keysecondary: [], comment: 'Ilse Varro', content: 'Ilse keeps the Lantern House and its ledger.', extensions: { names: ['Ilse Varro'] } };
    await makeWorld(page, book, { 0: entry });
    await page.locator('#WIDrawerIcon').click();
    await expect(page.locator('#Worldbuilding')).not.toBeVisible();
    const avatar = await characterReading(page, `Teller-${stamp}`, book);
    try {
        await openChatOf(page, avatar);
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
        await page.evaluate(async () => {
            // @ts-ignore
            await stTest.context().executeSlashCommandsWithOptions('/send We go to Ilse Varro, and her ledger.');
        });

        const text = page.locator('#chat .mes[mesid="1"] .mes_text');
        const link = text.locator('.chat-name');
        await expect(link).toHaveCount(1, { timeout: 15000 });
        await expect(link).toHaveText('Ilse Varro');
        const name = link.locator('.named');
        const thing = await name.getAttribute('data-thing');
        expect(thing).toMatch(/^\d+$/);
        await expect(name).toHaveClass(`named named-name look-${thing}`);
        await expect(text).toHaveText('We go to Ilse Varro, and her ledger.');
        await expect(text.getByText('ledger')).not.toHaveClass(/chat-name/);

        await link.hover();
        const card = page.locator('.wb-chat-card');
        await expect(card).toBeVisible();
        await expect(card.locator('.wb-entry-title')).toHaveText('Ilse Varro');
        await expect(card.locator('.wb-entry-readonly')).toHaveText('Ilse keeps the Lantern House and its ledger.');
        await expect(card.locator('.wb-hover-why')).toHaveCount(0);
        await page.mouse.move(0, 0);
        await expect(card).toBeHidden();

        await link.click();
        await expect(page.locator('#Worldbuilding .wb-entry .wb-entry-name')).toContainText('Ilse Varro', { timeout: 10000 });
        await expect(page.locator('#Worldbuilding .wb-switch-name')).toHaveText(book);
    } finally {
        await page.evaluate(async (avatar) => {
            // @ts-ignore
            const headers = stTest.context().getRequestHeaders();
            await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
        }, avatar);
        await deleteWorld(page, book);
    }
});
