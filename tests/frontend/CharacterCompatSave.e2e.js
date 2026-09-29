import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

// Upstream's whole-form saves, `createOrEditCharacter` and `saveCharacterDebounced`, re-exported from script.js
// for third-party extensions: they write a #form_create input, then call one of these.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const UNSET_VALUE = '__@@UNSET@@__';

const CHARACTER_WRITE_PATHS = new Set([
    '/api/characters/create', '/api/characters/rename', '/api/characters/edit', '/api/characters/edit-avatar',
    '/api/characters/edit-attribute', '/api/characters/merge-attributes', '/api/characters/fav', '/api/characters/chat',
    '/api/characters/allow-global-styles', '/api/characters/delete', '/api/characters/import', '/api/characters/duplicate',
]);
const CHAT_ROW_WRITE_PATHS = new Set(['/api/chats/save', '/api/chats/openings/ensure']);

/**
 * Every write request from here on: character writes (greeting ops included) and chat row writes, with JSON bodies.
 * @param {import('@playwright/test').Page} page
 * @returns {{path: string, body: any}[]}
 */
function recordWrites(page) {
    const writes = [];
    page.on('request', (request) => {
        if (request.method() !== 'POST') return;
        const path = new URL(request.url()).pathname;
        const isWrite = CHARACTER_WRITE_PATHS.has(path)
            || path.startsWith('/api/characters/greetings/')
            || CHAT_ROW_WRITE_PATHS.has(path)
            || path.startsWith('/api/chats/message/');
        if (!isWrite) return;
        let body;
        try { body = request.postDataJSON(); } catch { body = null; }
        writes.push({ path, body });
    });
    return writes;
}

/**
 * Creates a character through the API.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings The first is the default.
 * @returns {Promise<string>} The avatar filename.
 */
async function createCharacter(page, name, greetings) {
    return page.evaluate(async ({ name, greetings }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('description', 'stored description');
        form.set('first_mes', greetings[0]);
        for (const text of greetings.slice(1)) form.append('alternate_greetings', text);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, greetings });
}

/**
 * Opens the character in the editor and waits for its chat's opening.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
}

/**
 * Creates a character and opens it in the editor.
 * @param {import('@playwright/test').Page} page
 * @param {string} prefix
 * @param {string[]} [greetings]
 * @returns {Promise<string>}
 */
async function createAndOpen(page, prefix, greetings) {
    const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `${prefix}-${s}`, greetings ?? [`Hello ${s}`]);
    await openCharacter(page, avatar);
    return avatar;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<any>} The card as stored on the server.
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
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function deleteCharacter(page, avatar) {
    await page.evaluate(async (avatarUrl) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatarUrl, delete_chats: true }) });
    }, avatar);
}

/**
 * Sets an input's value the way an extension does: `.val()`, no event.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 * @param {string} value
 */
async function setInput(page, selector, value) {
    await page.evaluate(({ selector, value }) => {
        // @ts-ignore
        $(selector).val(value);
    }, { selector, value });
}

/**
 * Rewrites #character_json_data the way an extension does: parse, change, `.val()` back.
 * @param {import('@playwright/test').Page} page
 * @param {string} fnSource Body of `(card) => void`, mutating `card`.
 */
async function editJsonData(page, fnSource) {
    await page.evaluate((fnSource) => {
        // @ts-ignore
        const card = JSON.parse($('#character_json_data').val());
        new Function('card', fnSource)(card);
        // @ts-ignore
        $('#character_json_data').val(JSON.stringify(card));
    }, fnSource);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {any} [eventArg] 'newChat' passes `new CustomEvent('newChat')`.
 * @returns {Promise<{isPromise: boolean, resolved: any}>}
 */
async function callCreateOrEdit(page, eventArg) {
    return page.evaluate(async (eventArg) => {
        const { createOrEditCharacter } = await import('/script.js');
        const returned = eventArg === 'newChat' ? createOrEditCharacter(new CustomEvent('newChat')) : createOrEditCharacter();
        const isPromise = returned instanceof Promise;
        const resolved = await returned;
        return { isPromise, resolved: resolved === undefined ? '__undefined__' : resolved };
    }, eventArg);
}

/**
 * Starts recording the given events inside the page.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} eventKeys `event_types` keys.
 */
async function recordEvents(page, eventKeys) {
    await page.evaluate((eventKeys) => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        // @ts-ignore
        window.__compatEvents = [];
        for (const key of eventKeys) {
            ctx.eventSource.on(ctx.eventTypes[key], (...args) => {
                const detail = args[0]?.detail;
                // @ts-ignore
                window.__compatEvents.push({ key, args: detail ? [{ id: detail.id, avatar: detail.character?.avatar }] : args });
            });
        }
    }, eventKeys);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{key: string, args: any[]}[]>}
 */
async function recordedEvents(page) {
    // @ts-ignore
    return page.evaluate(() => window.__compatEvents);
}

test.describe('createOrEditCharacter in edit mode', () => {
    test.beforeEach(testSetup.awaitST);

    test('with nothing changed it resolves undefined and writes nothing', async ({ page }) => {
        const avatar = await createAndOpen(page, 'CompatNoop');
        try {
            const writes = recordWrites(page);
            const result = await callCreateOrEdit(page);
            expect(result).toEqual({ isPromise: true, resolved: '__undefined__' });
            await page.waitForTimeout(1500);
            expect(writes).toEqual([]);
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('a card field written with .val() is saved alone, conflict-checked, with CHARACTER_EDITED carrying id', async ({ page }) => {
        const avatar = await createAndOpen(page, 'CompatField');
        try {
            await setInput(page, '#scenario_pole', 'written by an extension');
            await recordEvents(page, ['CHARACTER_EDITED']);
            const writes = recordWrites(page);

            await callCreateOrEdit(page, 'newChat');

            expect(writes).toHaveLength(1);
            expect(writes[0].path).toBe('/api/characters/merge-attributes');
            expect(writes[0].body).toEqual({
                avatar,
                scenario: 'written by an extension',
                data: { scenario: 'written by an extension' },
                _loadedFieldHashes: { 'data.scenario': expect.any(Number) },
            });

            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.scenario).toBe('written by an extension');
            expect(stored.data.description).toBe('stored description');

            const characterId = await page.evaluate(() => {
                // @ts-ignore
                return SillyTavern.getContext().characterId;
            });
            const edited = await recordedEvents(page);
            expect(edited).toHaveLength(1);
            expect(edited[0].args[0].avatar).toBe(avatar);
            expect(edited[0].args[0].id).not.toBeUndefined();
            expect(String(edited[0].args[0].id)).toBe(String(characterId));
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('a field open in the field editor is not saved', async ({ page }) => {
        const avatar = await createAndOpen(page, 'CompatInEdit');
        try {
            await openInfoTab(page, 'description');
            await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
            await page.locator('#description_textarea').fill('unconfirmed description');
            const writes = recordWrites(page);

            await callCreateOrEdit(page, 'newChat');
            await page.waitForTimeout(1500);

            expect(writes).toEqual([]);
            expect((await fetchStoredCharacter(page, avatar)).data.description).toBe('stored description');
            await expect(page.locator('#description_textarea')).toHaveValue('unconfirmed description');
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('#character_json_data: only the changed paths are sent, without a hash check, and a second call sends nothing', async ({ page }) => {
        const avatar = await createAndOpen(page, 'CompatJsonPaths');
        try {
            const writes = recordWrites(page);
            await editJsonData(page, `card.data.extensions.compat_test = { answer: 42 }; card.data.nickname = 'Nick';`);

            await callCreateOrEdit(page, 'newChat');

            expect(writes).toHaveLength(1);
            expect(writes[0].path).toBe('/api/characters/merge-attributes');
            expect(writes[0].body).toEqual({
                avatar,
                data: { extensions: { compat_test: { answer: 42 } }, nickname: 'Nick' },
            });

            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.extensions.compat_test).toEqual({ answer: 42 });
            expect(stored.data.nickname).toBe('Nick');
            expect(stored.data.description).toBe('stored description');

            await callCreateOrEdit(page, 'newChat');
            await page.waitForTimeout(1500);
            expect(writes).toHaveLength(1);
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('#character_json_data: a path present when loaded and removed from the form is unset', async ({ page }) => {
        const avatar = await createAndOpen(page, 'CompatJsonUnset');
        try {
            await page.evaluate(async (avatar) => {
                // @ts-ignore
                await SillyTavern.getContext().writeExtensionField(avatar, 'compat_gone', { x: 1 });
            }, avatar);
            expect((await fetchStoredCharacter(page, avatar)).data.extensions.compat_gone).toEqual({ x: 1 });

            const writes = recordWrites(page);
            await editJsonData(page, 'delete card.data.extensions.compat_gone;');

            await callCreateOrEdit(page, 'newChat');

            expect(writes).toHaveLength(1);
            expect(writes[0].body).toEqual({ avatar, data: { extensions: { compat_gone: UNSET_VALUE } } });
            const stored = await fetchStoredCharacter(page, avatar);
            expect(Object.hasOwn(stored.data.extensions, 'compat_gone')).toBe(false);
            expect(stored.data.description).toBe('stored description');
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('#character_json_data that is not a JSON object is skipped with a console warning', async ({ page }) => {
        const avatar = await createAndOpen(page, 'CompatJsonBad');
        try {
            const warnings = [];
            page.on('console', (message) => {
                if (message.type() === 'warning') warnings.push(message.text());
            });
            const writes = recordWrites(page);
            await setInput(page, '#character_json_data', '{ not json');

            const result = await callCreateOrEdit(page, 'newChat');
            await page.waitForTimeout(1500);

            expect(result.resolved).toBe('__undefined__');
            expect(writes).toEqual([]);
            expect(warnings.some(text => text.includes('#character_json_data'))).toBe(true);
            expect((await fetchStoredCharacter(page, avatar)).data.description).toBe('stored description');
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('#character_json_data greetings go through the greeting operations, not merge-attributes', async ({ page }) => {
        const s = Date.now();
        const [g0, g1] = [`Zero ${s}`, `One ${s}`];
        const avatar = await createAndOpen(page, 'CompatJsonGreetings', [g0, g1]);
        try {
            const writes = recordWrites(page);
            const g0e = `Zero edited ${s}`;
            const g2 = `Two ${s}`;
            await editJsonData(page, `card.first_mes = ${JSON.stringify(g0e)}; card.data.first_mes = ${JSON.stringify(g0e)}; card.data.alternate_greetings = [${JSON.stringify(g1)}, ${JSON.stringify(g2)}];`);

            await callCreateOrEdit(page, 'newChat');

            expect(writes.map(w => w.path)).toEqual(['/api/characters/greetings/edit', '/api/characters/greetings/add']);
            expect(writes[0].body).toMatchObject({ avatar_url: avatar, position: 0, text: g0e, expected_hash: expect.anything() });
            expect(writes[1].body).toEqual({ avatar_url: avatar, append: true, text: g2 });

            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.first_mes).toBe(g0e);
            expect(stored.data.alternate_greetings).toEqual([g1, g2]);
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('a greeting changed elsewhere since load is refused, not overwritten', async ({ page }) => {
        const s = Date.now();
        const g0 = `Zero ${s}`;
        const avatar = await createAndOpen(page, 'CompatGreetingConflict', [g0]);
        try {
            const elsewhere = `Changed elsewhere ${s}`;
            // Leaves #character_json_data holding the greeting as loaded, so its hash no longer matches the server's.
            const changed = await page.evaluate(async (elsewhere) => {
                const { saveGreetingField } = await import('/script.js');
                return saveGreetingField(elsewhere);
            }, elsewhere);
            expect(changed).toBe(true);
            const writes = recordWrites(page);
            const mine = `Mine ${s}`;
            await editJsonData(page, `card.first_mes = ${JSON.stringify(mine)}; card.data.first_mes = ${JSON.stringify(mine)};`);

            await callCreateOrEdit(page, 'newChat');

            expect(writes.map(w => w.path)).toEqual(['/api/characters/greetings/edit']);
            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.first_mes).toBe(elsewhere);
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('#create_date_pole and #selected_chat_pole written by an extension are saved once each', async ({ page }) => {
        const avatar = await createAndOpen(page, 'CompatDateChat');
        try {
            const writes = recordWrites(page);
            const date = '2020-01-02T03:04:05.000Z';
            await setInput(page, '#create_date_pole', date);
            await setInput(page, '#selected_chat_pole', 'compat-pointer');

            await callCreateOrEdit(page, 'newChat');

            expect(writes.map(w => w.path).sort()).toEqual(['/api/characters/chat', '/api/characters/merge-attributes']);
            expect(writes.find(w => w.path === '/api/characters/merge-attributes').body).toEqual({ avatar, create_date: date });
            expect(writes.find(w => w.path === '/api/characters/chat').body).toEqual({ avatar, chat: 'compat-pointer' });
            expect((await fetchStoredCharacter(page, avatar)).create_date).toBe(date);

            await callCreateOrEdit(page, 'newChat');
            await page.waitForTimeout(1500);
            expect(writes).toHaveLength(2);
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('never posts the whole form to /api/characters/edit', async ({ page }) => {
        const avatar = await createAndOpen(page, 'CompatNoEdit');
        try {
            const paths = [];
            page.on('request', (request) => paths.push(new URL(request.url()).pathname));
            await setInput(page, '#scenario_pole', 'changed');
            await editJsonData(page, 'card.data.extensions.compat_x = 1;');
            await callCreateOrEdit(page, 'newChat');
            await page.waitForTimeout(1500);
            expect(paths).not.toContain('/api/characters/edit');
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('the first message is redrawn with upstream\'s events and no stored rows; a newChat event skips it', async ({ page }) => {
        const avatar = await createAndOpen(page, 'CompatFirstMessage');
        try {
            await recordEvents(page, ['MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED']);
            const writes = recordWrites(page);

            await callCreateOrEdit(page, 'newChat');
            expect(await recordedEvents(page)).toEqual([]);

            await callCreateOrEdit(page);
            expect(await recordedEvents(page)).toEqual([
                { key: 'MESSAGE_RECEIVED', args: [0, 'first_message'] },
                { key: 'CHARACTER_MESSAGE_RENDERED', args: [0, 'first_message'] },
            ]);
            await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
            await page.waitForTimeout(1500);
            expect(writes).toEqual([]);
        } finally {
            await deleteCharacter(page, avatar);
        }
    });
});

test.describe('saveCharacterDebounced', () => {
    test.beforeEach(testSetup.awaitST);

    test('takes no arguments, returns nothing, and repeated calls coalesce into one save', async ({ page }) => {
        const avatar = await createAndOpen(page, 'CompatDebounced');
        try {
            const writes = recordWrites(page);
            await setInput(page, '#scenario_pole', 'debounced scenario');

            const returned = await page.evaluate(async () => {
                const { saveCharacterDebounced } = await import('/script.js');
                const results = [saveCharacterDebounced(), saveCharacterDebounced(), saveCharacterDebounced()];
                return results.map(r => r === undefined);
            });
            expect(returned).toEqual([true, true, true]);
            expect(writes).toEqual([]);

            await expect.poll(() => writes.length, { timeout: 10000 }).toBe(1);
            await page.waitForTimeout(2500);
            expect(writes).toHaveLength(1);
            expect(writes[0].path).toBe('/api/characters/merge-attributes');
            expect(writes[0].body.data).toEqual({ scenario: 'debounced scenario' });
            expect((await fetchStoredCharacter(page, avatar)).data.scenario).toBe('debounced scenario');
        } finally {
            await deleteCharacter(page, avatar);
        }
    });
});

test.describe('createOrEditCharacter in create mode', () => {
    test.beforeEach(testSetup.awaitST);

    test('creates from the form: .val() inputs, #greeting_field, #character_json_data as base, #character_book_json kept as-is', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const name = `CompatCreate-${s}`;
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'createcharacter');

        const book = {
            name: `Book ${s}`,
            extensions: {},
            entries: [{ id: 0, keys: ['apple'], secondary_keys: [], content: 'An apple.', extensions: {}, enabled: true, insertion_order: 100, case_sensitive: false, name: 'apple', priority: 10, comment: '', selective: false, constant: false, position: 'before_char' }],
        };
        await setInput(page, '#character_name_pole', name);
        await setInput(page, '#description_textarea', 'form description');
        await setInput(page, '#greeting_field', `Greeting ${s}`);
        await setInput(page, '#character_json_data', JSON.stringify({ data: { nickname: 'Nick', extensions: { compat_create: { k: 1 } } }, compat_top: 'top' }));
        await setInput(page, '#character_book_json', JSON.stringify(book));

        const createResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/create');
        const result = await callCreateOrEdit(page);
        expect(result).toEqual({ isPromise: true, resolved: '__undefined__' });
        const avatar = await (await createResponse).text();
        try {
            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.name).toBe(name);
            expect(stored.data.description).toBe('form description');
            expect(stored.data.first_mes).toBe(`Greeting ${s}`);
            expect(stored.data.nickname).toBe('Nick');
            expect(stored.data.extensions.compat_create).toEqual({ k: 1 });
            expect(stored.compat_top).toBe('top');
            expect(stored.data.character_book).toEqual(book);
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('a scripted #create_button click creates from the form, .val() writes included', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const name = `CompatScriptedClick-${s}`;
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await setInput(page, '#character_name_pole', name);
        await setInput(page, '#scenario_pole', 'scripted scenario');

        const createResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/create');
        await page.evaluate(() => {
            // @ts-ignore
            $('#create_button').click();
        });
        const avatar = await (await createResponse).text();
        try {
            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.name).toBe(name);
            expect(stored.data.scenario).toBe('scripted scenario');
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('the user\'s own Create click leaves unconfirmed text out of the card', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const name = `CompatUserClick-${s}`;
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(name);
        await setInput(page, '#scenario_pole', 'UNCONFIRMED SCENARIO');

        const createResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/create');
        await page.locator('#create_button_label').click();
        const avatar = await (await createResponse).text();
        try {
            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.name).toBe(name);
            expect(stored.data.scenario).toBe('');
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('with an empty #character_json_data it creates from the form alone', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const name = `CompatCreatePlain-${s}`;
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await setInput(page, '#character_name_pole', name);
        await setInput(page, '#personality_textarea', 'form personality');

        const createResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/create');
        await callCreateOrEdit(page);
        const avatar = await (await createResponse).text();
        try {
            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.name).toBe(name);
            expect(stored.data.personality).toBe('form personality');
            expect(stored.data.character_book).toBeUndefined();
        } finally {
            await deleteCharacter(page, avatar);
        }
    });
});
