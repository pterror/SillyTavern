import { test, expect } from '@playwright/test';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function dismissWelcomePopupIfPresent(page) {
    const okButton = page.locator('.popup-button-ok');
    try {
        await okButton.first().waitFor({ state: 'visible', timeout: 5000 });
    } catch {
        return;
    }
    await okButton.first().click();
    await okButton.first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

/**
 * Sets an input's value without firing any event, i.e. text sitting in the form that no save trigger has seen.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 * @param {string} value
 */
async function setUnsavedInput(page, selector, value) {
    await page.locator(selector).evaluate((el, v) => { /** @type {HTMLTextAreaElement} */ (el).value = v; }, value);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<any>} The character card as stored on the server.
 */
async function fetchStoredCharacter(page, avatar) {
    return page.evaluate(async (avatarUrl) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatarUrl }) });
        return response.json();
    }, avatar);
}

/**
 * Collects the JSON body of every /api/characters/merge-attributes request from here on.
 * @param {import('@playwright/test').Page} page
 * @returns {any[]}
 */
function recordMergeRequests(page) {
    const bodies = [];
    page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().endsWith('/api/characters/merge-attributes')) {
            bodies.push(request.postDataJSON());
        }
    });
    return bodies;
}

/**
 * Creates a character through the Create form and opens it in the editor.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>} The new character's avatar filename.
 */
async function createAndOpenCharacter(page, name) {
    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button_label').click();
    await page.locator('.character_select', { hasText: name }).first().click();
    await page.locator('#tagInput').waitFor({ state: 'visible', timeout: 10000 });
    return String(await page.locator('#avatar_url_pole').inputValue());
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function deleteOpenCharacter(page) {
    await page.locator('#delete_button').click();
    const confirmButton = page.locator('.popup-button-ok');
    await confirmButton.first().waitFor({ state: 'visible', timeout: 5000 });
    await confirmButton.first().click();
}

test.describe('field-scoped character saves', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => dismissWelcomePopupIfPresent(page));

    test('editing one field sends only that field and leaves other fields\' unsaved input unsaved', async ({ page }) => {
        const avatar = await createAndOpenCharacter(page, `FieldScopedSave-${Date.now()}`);
        try {
            const mergeBodies = recordMergeRequests(page);

            await setUnsavedInput(page, '#scenario_pole', 'UNSAVED SCENARIO');
            await setUnsavedInput(page, '#personality_textarea', 'UNSAVED PERSONALITY');
            await openInfoTab(page, 'description');
            await page.locator('#description_textarea').fill('saved description');

            await expect.poll(() => mergeBodies.length, { timeout: 10000 }).toBe(1);
            await expect.poll(async () => (await fetchStoredCharacter(page, avatar)).data.description).toBe('saved description');

            expect(mergeBodies[0]).toEqual({
                avatar,
                description: 'saved description',
                data: { description: 'saved description' },
                _loadedFieldHashes: { 'data.description': expect.any(Number) },
            });

            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.scenario).toBe('');
            expect(stored.data.personality).toBe('');
        } finally {
            await deleteOpenCharacter(page);
        }
    });

    test('two fields edited within one debounce window are saved by one request each', async ({ page }) => {
        const avatar = await createAndOpenCharacter(page, `FieldScopedSaveTwo-${Date.now()}`);
        try {
            const mergeBodies = recordMergeRequests(page);

            await openInfoTab(page, 'description');
            await page.locator('#description_textarea').fill('first field');
            await openInfoTab(page, 'personality');
            await page.locator('#personality_textarea').fill('second field');

            await expect.poll(() => mergeBodies.length, { timeout: 10000 }).toBe(2);
            const sentFields = mergeBodies.map(body => Object.keys(body.data));
            expect(sentFields).toEqual(expect.arrayContaining([['description'], ['personality']]));
            for (const body of mergeBodies) {
                expect(Object.keys(body._loadedFieldHashes)).toHaveLength(1);
            }

            await expect.poll(async () => {
                const stored = await fetchStoredCharacter(page, avatar);
                return [stored.data.description, stored.data.personality];
            }).toEqual(['first field', 'second field']);
        } finally {
            await deleteOpenCharacter(page);
        }
    });

    test('the field save callable sends only its own field, with the value it is given', async ({ page }) => {
        const avatar = await createAndOpenCharacter(page, `FieldScopedSaveCallable-${Date.now()}`);
        try {
            const mergeBodies = recordMergeRequests(page);
            await setUnsavedInput(page, '#system_prompt_textarea', 'text in the textarea');
            await setUnsavedInput(page, '#description_textarea', 'UNSAVED DESCRIPTION');

            const saved = await page.evaluate(async () => {
                const script = await import('/script.js');
                return script.saveSystemPromptField('confirmed value');
            });
            expect(saved).toBe(true);

            expect(mergeBodies).toHaveLength(1);
            expect(mergeBodies[0].data).toEqual({ system_prompt: 'confirmed value' });

            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.system_prompt).toBe('confirmed value');
            expect(stored.data.description).toBe('');
        } finally {
            await deleteOpenCharacter(page);
        }
    });

    test('Create builds the character from confirmed values, not from what sits in the form', async ({ page }) => {
        const name = `FieldScopedCreate-${Date.now()}`;
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(name);
        await openInfoTab(page, 'description');
        await page.locator('#description_textarea').fill('typed description');
        await setUnsavedInput(page, '#personality_textarea', 'UNSAVED PERSONALITY');

        const createResponse = page.waitForResponse(response => response.url().endsWith('/api/characters/create'));
        await page.locator('#create_button_label').click();
        const avatar = await (await createResponse).text();

        await page.locator('.character_select', { hasText: name }).first().click();
        await page.locator('#tagInput').waitFor({ state: 'visible', timeout: 10000 });
        try {
            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.name).toBe(name);
            expect(stored.data.description).toBe('typed description');
            expect(stored.data.personality).toBe('');
        } finally {
            await deleteOpenCharacter(page);
        }
    });
});
