import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** Every `charInfoTabs_tab` radio value, with the create-request key of the field its tab shows. */
const TABS = [
    { tab: 'creatorNotes', key: 'creator_notes' },
    { tab: 'description', key: 'description' },
    { tab: 'greeting', key: 'first_mes' },
    { tab: 'mainPrompt', key: 'system_prompt' },
    { tab: 'postHistoryInstructions', key: 'post_history_instructions' },
    { tab: 'personality', key: 'personality' },
    { tab: 'scenario', key: 'scenario' },
    { tab: 'characterNote', key: 'depth_prompt_prompt' },
    { tab: 'exampleMessages', key: 'mes_example' },
];

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * @param {import('@playwright/test').Page} page
 */
async function awaitAppReady(page) {
    await page.evaluate(() => new Promise((resolve) => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        ctx.eventSource.once(ctx.eventTypes.APP_READY, resolve);
    }));
}

/**
 * Creates a character, opens it in the editor, runs `body`, then deletes the character.
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, string>} values Create-request fields other than the name.
 * @param {() => Promise<void>} body
 */
async function withCharacter(page, values, body) {
    const avatar = await page.evaluate(async ({ name, values }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        for (const [key, value] of Object.entries(values)) form.set(key, value);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name: `TabDim-${stamp()}`, values });
    try {
        await openCharacterManagementDrawer(page);
        await page.evaluate(async (avatar) => {
            // @ts-ignore
            await SillyTavern.getContext().getCharacters();
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
        }, avatar);
        await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
        await body();
    } finally {
        await page.evaluate(async (avatar) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            const response = await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
            if (!response.ok) throw new Error(`delete failed: ${response.status}`);
        }, avatar);
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} tab The tab's `charInfoTabs_tab` radio value.
 */
function heading(page, tab) {
    return page.locator(`#charInfoTabs > .tab-title:has(> input[value="${tab}"])`);
}

test.describe('character info tab dimming', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => awaitAppReady(page));

    test('every tab of a character with nothing filled in is dimmed', async ({ page }) => {
        await withCharacter(page, {}, async () => {
            for (const { tab } of TABS) {
                await expect(heading(page, tab), tab).toHaveClass(/\btab-empty\b/);
            }
            // The selected tab is always shown at full opacity, so look at one that is not selected.
            await openInfoTab(page, 'description');
            await expect(heading(page, 'creatorNotes')).toHaveCSS('opacity', '0.5');
        });
    });

    test('no tab of a character with every field filled in is dimmed', async ({ page }) => {
        const values = Object.fromEntries(TABS.map(({ key }) => [key, `Text of ${key}`]));
        await withCharacter(page, values, async () => {
            for (const { tab } of TABS) {
                await expect(heading(page, tab), tab).not.toHaveClass(/\btab-empty\b/);
            }
        });
    });

    test('only the empty field\'s tab is dimmed', async ({ page }) => {
        const values = Object.fromEntries(TABS.filter(({ tab }) => tab !== 'creatorNotes').map(({ key }) => [key, `Text of ${key}`]));
        await withCharacter(page, values, async () => {
            for (const { tab } of TABS) {
                if (tab === 'creatorNotes') {
                    await expect(heading(page, tab), tab).toHaveClass(/\btab-empty\b/);
                } else {
                    await expect(heading(page, tab), tab).not.toHaveClass(/\btab-empty\b/);
                }
            }
        });
    });

    test('a field holding only whitespace is not dimmed, and dims again once cleared', async ({ page }) => {
        await withCharacter(page, { first_mes: 'Greeting' }, async () => {
            await openInfoTab(page, 'personality');
            await expect(heading(page, 'personality')).toHaveClass(/\btab-empty\b/);
            await page.locator('.field_edit_toggle[data-for="personality_textarea"]').click();
            await page.locator('#personality_textarea').fill(' ');
            await expect(heading(page, 'personality')).not.toHaveClass(/\btab-empty\b/);
            await page.locator('#personality_textarea').fill('');
            await expect(heading(page, 'personality')).toHaveClass(/\btab-empty\b/);
        });
    });

    test('the greetings tab stays bright while an empty greeting is shown and another has text', async ({ page }) => {
        await withCharacter(page, { first_mes: 'Greeting' }, async () => {
            await openInfoTab(page, 'greeting');
            await expect(heading(page, 'greeting')).not.toHaveClass(/\btab-empty\b/);
            await page.locator('.greeting-pager-add').click();
            await expect(page.locator('#greeting_field')).toHaveValue('');
            await expect(heading(page, 'greeting')).not.toHaveClass(/\btab-empty\b/);
        });
    });
});
