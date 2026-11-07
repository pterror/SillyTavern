import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { startLlamaCpp, createCharacter, openCharacter, connectLlamaCpp } from './llamacpp-mock.js';

test('the persona description and the author\'s note are counted in the answers to their saves, not by the page', async ({ page }) => {
    const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const mock = await startLlamaCpp();
    try {
        await testSetup.awaitST({ page });
        const avatar = await createCharacter(page, `Editor ${s}`, `Greeting ${s}`);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);

        /** @type {string[]} */
        const counted = [];
        page.on('request', (request) => {
            if (new URL(request.url()).pathname === '/api/tokenizers/current/count') counted.push(request.postData() ?? '');
        });
        const settingsSaved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial') && response.ok());
        await page.evaluate((s) => {
            const field = /** @type {HTMLTextAreaElement} */ (document.querySelector('#persona_description'));
            field.value = `A traveller ${s} from the far north.`;
            field.dispatchEvent(new Event('input', { bubbles: true }));
        }, s);
        const settingsAnswer = await (await settingsSaved).json();
        expect(typeof settingsAnswer.shown_counts?.persona).toBe('number');
        await expect(page.locator('#persona_description_token_count')).toHaveText(String(settingsAnswer.shown_counts.persona));

        const noteSaved = page.waitForResponse(response => response.url().endsWith('/api/chats/metadata') && response.ok());
        await page.evaluate((s) => {
            const field = /** @type {HTMLTextAreaElement} */ (document.querySelector('#extension_floating_prompt'));
            field.value = `It rains ${s} all day.`;
            field.dispatchEvent(new Event('input', { bubbles: true }));
        }, s);
        const noteAnswer = await (await noteSaved).json();
        expect(typeof noteAnswer.shown_counts?.chat_note).toBe('number');
        await expect(page.locator('#extension_floating_prompt_token_counter')).toHaveText(String(noteAnswer.shown_counts.chat_note));

        expect(counted.filter(body => body.includes(s))).toEqual([]);
    } finally {
        await mock.close();
    }
});
