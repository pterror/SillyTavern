import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

const NESTED = '*a **b** a*';
const NESTED_HTML = 'a <strong>b</strong> a';

/** @param {import('@playwright/test').Page} page */
async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ has: boolean, value: unknown }>} The key as settings.json on the server holds it.
 */
async function storedAutoFix(page) {
    return page.evaluate(async () => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders();
        const response = await fetch('/api/settings/get', { method: 'POST', headers, body: '{}', cache: 'no-cache' });
        const powerUser = JSON.parse((await response.json()).settings).power_user ?? {};
        return { has: Object.hasOwn(powerUser, 'auto_fix_generated_markdown'), value: powerUser.auto_fix_generated_markdown };
    });
}

test.describe('Auto-fix Markdown, with an old settings file that has it on', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.evaluate(async () => {
            const headers = window['SillyTavern'].getContext().getRequestHeaders();
            const response = await fetch('/api/settings/save-partial', {
                method: 'POST',
                headers,
                body: JSON.stringify({ keys: { 'power_user.auto_fix_generated_markdown': true } }),
            });
            if (!response.ok) throw new Error(`seeding the old setting failed: ${response.status}`);
        });
        expect(await storedAutoFix(page)).toEqual({ has: true, value: true });
        await page.reload();
        await testSetup.awaitST({ page });
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    test('the setting reads as off, takes writes without effect, and has no checkbox', async ({ page }) => {
        const seen = await page.evaluate(async () => {
            const { power_user, fixMarkdown } = await import('/scripts/power-user.js');
            const context = window['SillyTavern'].getContext();
            const afterLoad = power_user.auto_fix_generated_markdown;
            power_user.auto_fix_generated_markdown = true;
            Object.assign(power_user, { auto_fix_generated_markdown: true });
            return {
                afterLoad,
                afterWrite: power_user.auto_fix_generated_markdown,
                fromContext: context.powerUserSettings.auto_fix_generated_markdown,
                inKeys: Object.keys(power_user).includes('auto_fix_generated_markdown'),
                inJson: JSON.stringify(power_user).includes('auto_fix_generated_markdown'),
                inSpread: Object.hasOwn({ ...power_user }, 'auto_fix_generated_markdown'),
                fixed: [fixMarkdown('* a * "b', true), fixMarkdown('* a * "b', false), fixMarkdown('* a * "b')],
            };
        });
        expect(seen).toEqual({
            afterLoad: false,
            afterWrite: false,
            fromContext: false,
            inKeys: false,
            inJson: false,
            inSpread: false,
            fixed: ['* a * "b', '* a * "b', '* a * "b'],
        });
        await expect(page.locator('#auto_fix_generated_markdown')).toHaveCount(0);
    });

    test('nothing is written for it until a full settings save has a real change, which leaves the key out', async ({ page }) => {
        expect(await storedAutoFix(page)).toEqual({ has: true, value: true });

        await page.evaluate(async () => {
            const { saveSettings } = await import('/script.js');
            await saveSettings();
        });
        expect(await storedAutoFix(page)).toEqual({ has: true, value: true });

        await page.evaluate(async () => {
            const { saveSettings } = await import('/script.js');
            const { power_user } = await import('/scripts/power-user.js');
            power_user.console_log_prompts = !power_user.console_log_prompts;
            await saveSettings();
        });
        expect(await storedAutoFix(page)).toEqual({ has: false, value: undefined });
    });

    test('a chat message and a generated reply keep the spaces around nested emphasis', async ({ page }) => {
        const cleaned = await page.evaluate(async (text) => {
            const { newAssistantChat, cleanUpMessage } = await import('/script.js');
            await newAssistantChat({ temporary: true });
            const context = window['SillyTavern'].getContext();
            for (const isUser of [false, true]) {
                const message = { name: isUser ? 'User' : 'Bot', is_user: isUser, is_system: false, send_date: new Date().toISOString(), mes: text, extra: {} };
                context.chat.push(message);
                context.addOneMessage(message);
            }
            return cleanUpMessage({ getMessage: text, isImpersonate: false, isContinue: false });
        }, NESTED);
        expect(cleaned).toBe(NESTED);

        const messages = page.locator('#chat .mes');
        for (const message of [messages.nth(-2), messages.last()]) {
            const em = message.locator('.mes_text em');
            await expect(em).toHaveCount(1);
            expect(await em.innerHTML()).toBe(NESTED_HTML);
        }
    });

    test('the greeting preview keeps the spaces around nested emphasis', async ({ page }) => {
        const avatar = await page.evaluate(async (text) => {
            const headers = window['SillyTavern'].getContext().getRequestHeaders({ omitContentType: true });
            const form = new FormData();
            form.set('ch_name', `AutoFixGone-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
            form.set('first_mes', text);
            const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
            if (!response.ok) throw new Error(`create failed: ${response.status}`);
            return response.text();
        }, NESTED);
        try {
            await openCharacterManagementDrawer(page);
            await page.evaluate(async (avatar) => {
                await window['SillyTavern'].getContext().getCharacters();
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
            await openInfoTab(page, 'greeting');

            const em = page.locator('.field_preview[data-for="greeting_field"] em');
            await expect(em).toHaveCount(1);
            expect(await em.innerHTML()).toBe(NESTED_HTML);
        } finally {
            await page.evaluate(async (avatar) => {
                const headers = window['SillyTavern'].getContext().getRequestHeaders();
                await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
            }, avatar);
        }
    });
});
