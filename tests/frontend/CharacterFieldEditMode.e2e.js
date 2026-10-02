import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab, setStackedDrawers } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const FIELD_BLOCKED_TOAST = 'A field is being edited - confirm or cancel it first.';
const MESSAGE_BLOCKED_TOAST = 'A message is being edited - confirm or cancel it first.';

/**
 * @typedef {object} Field
 * @property {string} id Textarea id.
 * @property {string} tab The `charInfoTabs_tab` radio value of the field's tab.
 * @property {string} key The field's name in the create request, and under the stored card's `data` unless `stored` says otherwise.
 * @property {string[]} [stored] Where the stored card keeps the value, when that isn't `data[key]`.
 */

/** @type {Field[]} */
const FIELDS = [
    { id: 'creator_notes_textarea', tab: 'creatorNotes', key: 'creator_notes' },
    { id: 'description_textarea', tab: 'description', key: 'description' },
    { id: 'greeting_field', tab: 'greeting', key: 'first_mes' },
    { id: 'system_prompt_textarea', tab: 'mainPrompt', key: 'system_prompt' },
    { id: 'post_history_instructions_textarea', tab: 'postHistoryInstructions', key: 'post_history_instructions' },
    { id: 'personality_textarea', tab: 'personality', key: 'personality' },
    { id: 'scenario_pole', tab: 'scenario', key: 'scenario' },
    { id: 'depth_prompt_prompt', tab: 'characterNote', key: 'depth_prompt_prompt', stored: ['extensions', 'depth_prompt', 'prompt'] },
    { id: 'mes_example_textarea', tab: 'exampleMessages', key: 'mes_example' },
];

/**
 * @param {any} card A stored card, as /api/characters/get returns it.
 * @param {Field} field
 * @returns {any} The field's stored value.
 */
function storedValue(card, field) {
    return (field.stored ?? [field.key]).reduce((value, key) => value?.[key], card.data);
}

/** Every `charInfoTabs_tab` radio value, in tab order. */
const TABS = ['creatorNotes', 'description', 'greeting', 'mainPrompt', 'postHistoryInstructions', 'personality', 'scenario', 'characterNote', 'exampleMessages'];

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
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {Record<string, string>} values Create-request fields other than the name.
 * @returns {Promise<string>} The new character's avatar filename.
 */
async function createCharacter(page, name, values) {
    return page.evaluate(async ({ name, values }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        for (const [key, value] of Object.entries(values)) form.set(key, value);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, values });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function deleteCharacterOnServer(page, avatar) {
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
        if (!response.ok) throw new Error(`delete failed: ${response.status}`);
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} members Member avatars.
 * @returns {Promise<string>} The group's id.
 */
async function createGroup(page, name, members) {
    return page.evaluate(async ({ name, members }) => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        const response = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name, members }) });
        if (!response.ok) throw new Error(`group create failed: ${response.status}`);
        const data = await response.json();
        const { groupsStore } = await import('/scripts/group-chats.js');
        groupsStore.reportCreated(String(data.id));
        return String(data.id);
    }, { name, members });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
async function deleteGroupOnServer(page, id) {
    await page.evaluate(async (id) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/groups/delete', { method: 'POST', headers, body: JSON.stringify({ id }) });
        if (!response.ok) throw new Error(`group delete failed: ${response.status}`);
    }, id);
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
 * Opens the character in the editor, with the character list refreshed first.
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
}

/**
 * Collects the path of every request that saves a character field from here on.
 * @param {import('@playwright/test').Page} page
 * @returns {string[]}
 */
function recordSaveRequests(page) {
    /** @type {string[]} */
    const paths = [];
    page.on('request', (request) => {
        if (request.method() !== 'POST') return;
        const path = new URL(request.url()).pathname;
        if (path === '/api/characters/merge-attributes' || path === '/api/characters/edit-attribute' || path.startsWith('/api/characters/greetings/')) {
            paths.push(path);
        }
    });
    return paths;
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>}
 */
async function getAutoSaveTimeout(page) {
    return page.evaluate(async () => {
        const { DEFAULT_SAVE_EDIT_TIMEOUT } = await import('/script.js');
        return DEFAULT_SAVE_EDIT_TIMEOUT;
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {'auto_save_msg_edits' | 'click_to_edit'} key
 * @param {boolean} value
 * @returns {Promise<boolean>} The previous value.
 */
async function setPowerUserSetting(page, key, value) {
    return page.evaluate(async ({ key, value }) => {
        const { power_user } = await import('/scripts/power-user.js');
        const previous = power_user[key];
        power_user[key] = value;
        return previous;
    }, { key, value });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
function fieldLocators(page, id) {
    const textarea = page.locator(`#${id}`);
    const panel = page.locator('.char_info_tab_panel', { has: textarea });
    return {
        textarea,
        panel,
        preview: page.locator(`.field_preview[data-for="${id}"]`),
        pencil: page.locator(`.field_edit_toggle[data-for="${id}"]`),
        done: page.locator(`.field_edit_done[data-for="${id}"]`),
        cancel: page.locator(`.field_edit_cancel[data-for="${id}"]`),
        maximize: page.locator(`.field_maximize[data-for="${id}"]`),
        editor: panel.locator('.cm-editor'),
    };
}

/**
 * Replaces a field's text by typing in its editor, as a user does (the textarea itself is hidden while it's mounted).
 * @param {import('@playwright/test').Page} page
 * @param {ReturnType<typeof fieldLocators>} f
 * @param {string} text
 */
async function fillField(page, f, text) {
    await expect(f.editor).toBeVisible();
    await f.editor.locator('.cm-content').focus();
    await page.keyboard.press('Control+a');
    if (text) await page.keyboard.insertText(text);
    else await page.keyboard.press('Delete');
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {Field} field
 */
async function expectPreviewMode(page, field) {
    const f = fieldLocators(page, field.id);
    await expect(f.panel).not.toHaveClass(/\bfield_editing\b/);
    await expect(f.preview).toBeVisible();
    await expect(f.textarea).toBeHidden();
    await expect(f.pencil).toBeVisible();
    await expect(f.done).toBeHidden();
    await expect(f.cancel).toBeHidden();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {Field} field
 */
async function expectEditMode(page, field) {
    const f = fieldLocators(page, field.id);
    await expect(f.panel).toHaveClass(/\bfield_editing\b/);
    await expect(f.textarea).toBeVisible();
    await expect(f.preview).toBeHidden();
    await expect(f.pencil).toBeHidden();
    await expect(f.done).toBeVisible();
    await expect(f.cancel).toBeVisible();
}

/**
 * Shows the field's tab and enters edit mode with the pencil.
 * @param {import('@playwright/test').Page} page
 * @param {Field} field
 */
async function enterEdit(page, field) {
    await openInfoTab(page, field.tab);
    await fieldLocators(page, field.id).pencil.click();
    await expectEditMode(page, field);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
async function expectToast(page, text) {
    await expect(page.locator('#toast-container .toast-message', { hasText: text }).first()).toBeVisible({ timeout: 5000 });
}

/**
 * Pins the character info drawer open, so clicks in the chat leave it open, runs `body`, then unpins it.
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} body
 */
async function withDrawerPinned(page, body) {
    const pin = page.locator('#charInfo_button_panel_pin');
    const togglePin = () => pin.evaluate(el => (/** @type {HTMLInputElement} */ (el)).click());
    await expect(pin).not.toBeChecked();
    await togglePin();
    await expect(pin).toBeChecked();
    try {
        await body();
    } finally {
        await togglePin();
        await expect(pin).not.toBeChecked();
    }
}

/**
 * Sends a user message after the greeting and gives it a stored reasoning block.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>} The message's id.
 */
async function addUserMessageWithReasoning(page) {
    const mesId = await page.evaluate(async () => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        await ctx.SlashCommandParser.commands['send'].callback({}, 'a user message');
        return ctx.chat.length - 1;
    });
    await expect.poll(() => page.evaluate((mesId) => {
        // @ts-ignore
        const node = SillyTavern.getContext().chat[mesId]?.node_id;
        return typeof node === 'string' && !node.startsWith('card:');
    }, mesId), { timeout: 10000 }).toBe(true);
    const editResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chats/message/edit', { timeout: 15000 });
    await page.evaluate(async (mesId) => {
        const { updateMessage, chatOpEdit } = await import('/scripts/chat-store.js');
        const { updateMessageBlock } = await import('/script.js');
        const { chat } = await import('/scripts/chat-state.js');
        updateMessage(mesId, { extra: { ...chat[mesId].extra, reasoning: 'some reasoning' } });
        await chatOpEdit(mesId);
        updateMessageBlock(mesId, chat[mesId]);
    }, mesId);
    expect((await editResponse).ok()).toBe(true);
    const details = page.locator(`#chat .mes[mesid="${mesId}"] .mes_reasoning_details`);
    await details.locator('.mes_reasoning_header').click();
    await expect(details).toHaveAttribute('open', '');
    await expect(details.locator('.mes_reasoning')).toHaveText('some reasoning');
    return mesId;
}

/**
 * Creates a character holding `value` in `field` (and a greeting, unless `field` is the greeting), opens it,
 * runs `body`, then deletes the character.
 * @param {import('@playwright/test').Page} page
 * @param {Field} field
 * @param {string} value
 * @param {(avatar: string, name: string) => Promise<void>} body
 */
async function withCharacter(page, field, value, body) {
    const name = `FieldEdit-${stamp()}`;
    const avatar = await createCharacter(page, name, { first_mes: 'Greeting', [field.key]: value });
    try {
        await openCharacter(page, avatar);
        await body(avatar, name);
    } finally {
        await deleteCharacterOnServer(page, avatar);
    }
}

test('the app loads without page errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await testSetup.awaitST({ page });
    expect(errors).toEqual([]);
});

test.describe('character field edit mode', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => awaitAppReady(page));

    for (const field of FIELDS) {
        test.describe(`${field.id}`, () => {
            test('shows the preview first', async ({ page }) => {
                await withCharacter(page, field, `Stored ${field.key}`, async () => {
                    await openInfoTab(page, field.tab);
                    await expectPreviewMode(page, field);
                    await expect(fieldLocators(page, field.id).preview).toContainText(`Stored ${field.key}`);
                });
            });

            test('typing does not save', async ({ page }) => {
                await withCharacter(page, field, 'original', async (avatar) => {
                    await enterEdit(page, field);
                    const saves = recordSaveRequests(page);
                    await fillField(page, fieldLocators(page, field.id), 'typed');
                    // eslint-disable-next-line playwright/no-wait-for-timeout
                    await page.waitForTimeout(await getAutoSaveTimeout(page) + 2000);
                    expect(saves).toEqual([]);
                    expect(storedValue(await fetchStoredCharacter(page, avatar), field)).toBe('original');
                    await expectEditMode(page, field);
                    await fieldLocators(page, field.id).cancel.click();
                });
            });

            test('the confirm button saves and returns to the preview', async ({ page }) => {
                await withCharacter(page, field, 'original', async (avatar) => {
                    await enterEdit(page, field);
                    const saves = recordSaveRequests(page);
                    const f = fieldLocators(page, field.id);
                    await fillField(page, f, 'confirmed');
                    await f.done.click();
                    await expectPreviewMode(page, field);
                    await expect(f.preview).toContainText('confirmed');
                    await expect.poll(async () => storedValue(await fetchStoredCharacter(page, avatar), field)).toBe('confirmed');
                    expect(saves.length).toBeGreaterThan(0);
                });
            });

            test('Ctrl+Enter saves and returns to the preview', async ({ page }) => {
                await withCharacter(page, field, 'original', async (avatar) => {
                    await enterEdit(page, field);
                    const f = fieldLocators(page, field.id);
                    await fillField(page, f, 'confirmed by key');
                    await f.textarea.press('Control+Enter');
                    await expectPreviewMode(page, field);
                    await expect(f.preview).toContainText('confirmed by key');
                    await expect.poll(async () => storedValue(await fetchStoredCharacter(page, avatar), field)).toBe('confirmed by key');
                });
            });

            test('the cancel button restores the text and saves nothing', async ({ page }) => {
                await withCharacter(page, field, 'original', async (avatar) => {
                    await enterEdit(page, field);
                    const saves = recordSaveRequests(page);
                    const f = fieldLocators(page, field.id);
                    await fillField(page, f, 'discarded');
                    await f.cancel.click();
                    await expectPreviewMode(page, field);
                    await expect(f.textarea).toHaveValue('original');
                    await expect(f.preview).toContainText('original');
                    expect(saves).toEqual([]);
                    expect(storedValue(await fetchStoredCharacter(page, avatar), field)).toBe('original');
                });
            });

            test('Escape with no change ends the edit and leaves the drawer open', async ({ page }) => {
                await withCharacter(page, field, 'original', async () => {
                    await enterEdit(page, field);
                    const f = fieldLocators(page, field.id);
                    await f.textarea.press('Escape');
                    await expectPreviewMode(page, field);
                    await expect(page.locator('dialog[open]')).toHaveCount(0);
                    await page.waitForTimeout(1000);
                    await expect(page.locator('#char-info-panel')).toHaveClass(/\bopenDrawer\b/);
                });
            });

            test('Escape with a change asks first; No keeps the edit, Yes restores the text and saves nothing; the drawer stays open', async ({ page }) => {
                await withCharacter(page, field, 'original', async (avatar) => {
                    await enterEdit(page, field);
                    const saves = recordSaveRequests(page);
                    const f = fieldLocators(page, field.id);
                    await fillField(page, f, 'discarded by key');
                    await f.textarea.press('Escape');
                    const dialog = page.locator('dialog[open]');
                    await expect(dialog).toContainText('Discard your changes?');
                    await dialog.locator('.popup-button-cancel').click();
                    await expect(dialog).toHaveCount(0);
                    await expectEditMode(page, field);
                    await expect(f.textarea).toHaveValue('discarded by key');
                    await page.waitForTimeout(1000);
                    await expect(page.locator('#char-info-panel')).toHaveClass(/\bopenDrawer\b/);

                    await f.textarea.press('Escape');
                    await page.locator('dialog[open] .popup-button-ok').click();
                    await expectPreviewMode(page, field);
                    await page.waitForTimeout(1000);
                    await expect(page.locator('#char-info-panel')).toHaveClass(/\bopenDrawer\b/);
                    await expect(f.textarea).toHaveValue('original');
                    await expect(f.preview).toContainText('original');
                    expect(saves).toEqual([]);
                    expect(storedValue(await fetchStoredCharacter(page, avatar), field)).toBe('original');
                });
            });

            test.describe('with auto_save_msg_edits on', () => {
                test('typing saves after the debounce and stays in edit mode', async ({ page }) => {
                    const previous = await setPowerUserSetting(page, 'auto_save_msg_edits', true);
                    try {
                        await withCharacter(page, field, 'original', async (avatar) => {
                            await enterEdit(page, field);
                            const f = fieldLocators(page, field.id);
                            await fillField(page, f, 'autosaved');
                            await expect.poll(async () => storedValue(await fetchStoredCharacter(page, avatar), field), { timeout: 10000 }).toBe('autosaved');
                            await expectEditMode(page, field);
                            await f.cancel.click();
                        });
                    } finally {
                        await setPowerUserSetting(page, 'auto_save_msg_edits', previous);
                    }
                });

                test('Escape confirms', async ({ page }) => {
                    const previous = await setPowerUserSetting(page, 'auto_save_msg_edits', true);
                    try {
                        await withCharacter(page, field, 'original', async (avatar) => {
                            await enterEdit(page, field);
                            const f = fieldLocators(page, field.id);
                            await fillField(page, f, 'confirmed by escape');
                            await f.textarea.press('Escape');
                            await expectPreviewMode(page, field);
                            await expect(page.locator('dialog[open]')).toHaveCount(0);
                            await page.waitForTimeout(1000);
                            await expect(page.locator('#char-info-panel')).toHaveClass(/\bopenDrawer\b/);
                            await expect(f.preview).toContainText('confirmed by escape');
                            await expect.poll(async () => storedValue(await fetchStoredCharacter(page, avatar), field)).toBe('confirmed by escape');
                        });
                    } finally {
                        await setPowerUserSetting(page, 'auto_save_msg_edits', previous);
                    }
                });

                test('the cancel button keeps the autosaved value', async ({ page }) => {
                    const previous = await setPowerUserSetting(page, 'auto_save_msg_edits', true);
                    try {
                        await withCharacter(page, field, 'original', async (avatar) => {
                            await enterEdit(page, field);
                            const f = fieldLocators(page, field.id);
                            await fillField(page, f, 'kept');
                            await expect.poll(async () => storedValue(await fetchStoredCharacter(page, avatar), field), { timeout: 10000 }).toBe('kept');
                            await f.cancel.click();
                            await expectPreviewMode(page, field);
                            await expect(f.textarea).toHaveValue('kept');
                            await expect(f.preview).toContainText('kept');
                            expect(storedValue(await fetchStoredCharacter(page, avatar), field)).toBe('kept');
                        });
                    } finally {
                        await setPowerUserSetting(page, 'auto_save_msg_edits', previous);
                    }
                });
            });

            test.describe('blocked while the field is in edit', () => {
                test('switching to another character', async ({ page }) => {
                    const otherName = `FieldEditOther-${stamp()}`;
                    const other = await createCharacter(page, otherName, {});
                    try {
                        await withCharacter(page, field, 'original', async (avatar) => {
                            await enterEdit(page, field);
                            const f = fieldLocators(page, field.id);
                            await fillField(page, f, 'in progress');
                            await page.evaluate(async (other) => {
                                const { selectCharacterByAvatar } = await import('/script.js');
                                await selectCharacterByAvatar(other);
                            }, other);
                            await expectToast(page, FIELD_BLOCKED_TOAST);
                            await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);
                            await expectEditMode(page, field);
                            await expect(f.textarea).toHaveValue('in progress');
                            await f.cancel.click();
                        });
                    } finally {
                        await deleteCharacterOnServer(page, other);
                    }
                });

                test('opening a group', async ({ page }) => {
                    await withCharacter(page, field, 'original', async (avatar) => {
                        const groupId = await createGroup(page, `FieldEditGroup-${stamp()}`, [avatar]);
                        try {
                            await openCharacter(page, avatar);
                            await enterEdit(page, field);
                            const f = fieldLocators(page, field.id);
                            await fillField(page, f, 'in progress');
                            const opened = await page.evaluate(async (groupId) => {
                                const { openGroupById } = await import('/scripts/group-chats.js');
                                return openGroupById(groupId);
                            }, groupId);
                            expect(opened).toBe(false);
                            await expectToast(page, FIELD_BLOCKED_TOAST);
                            await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);
                            expect(await page.evaluate(() => {
                                // @ts-ignore
                                return SillyTavern.getContext().groupId;
                            })).toBeFalsy();
                            await expectEditMode(page, field);
                            await expect(f.textarea).toHaveValue('in progress');
                            await f.cancel.click();
                        } finally {
                            await deleteGroupOnServer(page, groupId);
                        }
                    });
                });

                test('Create in create mode', async ({ page }) => {
                    await openCharacterManagementDrawer(page);
                    await page.locator('#rm_button_create').click();
                    await page.locator('#character_name_pole').fill(`FieldEditCreate-${stamp()}`);
                    await enterEdit(page, field);
                    const f = fieldLocators(page, field.id);
                    await fillField(page, f, 'in progress');
                    /** @type {string[]} */
                    const creates = [];
                    page.on('request', (request) => {
                        if (new URL(request.url()).pathname === '/api/characters/create') creates.push(request.url());
                    });
                    await page.locator('#create_button_label').click();
                    await expectToast(page, FIELD_BLOCKED_TOAST);
                    await expectEditMode(page, field);
                    await expect(f.textarea).toHaveValue('in progress');
                    expect(creates).toEqual([]);
                    await f.cancel.click();
                });

                test('starting a chat-message edit', async ({ page }) => {
                    await withCharacter(page, field, 'original', async () => {
                        await withDrawerPinned(page, async () => {
                            await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
                            await enterEdit(page, field);
                            const f = fieldLocators(page, field.id);
                            await fillField(page, f, 'in progress');
                            await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
                            await expectToast(page, FIELD_BLOCKED_TOAST);
                            await expect(page.locator('#curEditTextarea')).toHaveCount(0);
                            await expectEditMode(page, field);
                            await expect(f.textarea).toHaveValue('in progress');
                            await f.cancel.click();
                        });
                    });
                });

                if (field.id !== 'greeting_field') {
                    test('opening the greetings popup', async ({ page }) => {
                        await withCharacter(page, field, 'original', async () => {
                            await enterEdit(page, field);
                            const f = fieldLocators(page, field.id);
                            await fillField(page, f, 'in progress');
                            // Its button is on the greeting tab, which can't be opened mid-edit; other code can still press it.
                            await page.locator('.open_alternate_greetings').first().evaluate(el => (/** @type {HTMLElement} */ (el)).click());
                            await expectToast(page, FIELD_BLOCKED_TOAST);
                            await expect(page.locator('.popup .alternate_greetings_list')).toHaveCount(0);
                            await expectEditMode(page, field);
                            await expect(f.textarea).toHaveValue('in progress');
                            await f.cancel.click();
                        });
                    });
                }

            });

            test('starting the field edit is blocked while a chat message is being edited', async ({ page }) => {
                await withCharacter(page, field, 'original', async () => {
                    await withDrawerPinned(page, async () => {
                        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
                        await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
                        await expect(page.locator('#curEditTextarea')).toBeVisible();
                        try {
                            await openInfoTab(page, field.tab);
                            await fieldLocators(page, field.id).pencil.click();
                            await expectToast(page, MESSAGE_BLOCKED_TOAST);
                            await expectPreviewMode(page, field);
                        } finally {
                            await page.locator('#chat .mes[mesid="0"] .mes_edit_cancel').click();
                        }
                    });
                });
            });

            test('starting a reasoning-block edit is blocked while the field is in edit', async ({ page }) => {
                await withCharacter(page, field, 'original', async () => {
                    await withDrawerPinned(page, async () => {
                        const mesId = await addUserMessageWithReasoning(page);
                        await enterEdit(page, field);
                        const f = fieldLocators(page, field.id);
                        await fillField(page, f, 'in progress');
                        await page.locator(`#chat .mes[mesid="${mesId}"] .mes_reasoning_edit`).click();
                        await expectToast(page, FIELD_BLOCKED_TOAST);
                        await expect(page.locator('.reasoning_edit_textarea')).toHaveCount(0);
                        await expectEditMode(page, field);
                        await expect(f.textarea).toHaveValue('in progress');
                        await f.cancel.click();
                    });
                });
            });

            test('starting the field edit is blocked while a reasoning block is being edited', async ({ page }) => {
                await withCharacter(page, field, 'original', async () => {
                    await withDrawerPinned(page, async () => {
                        const mesId = await addUserMessageWithReasoning(page);
                        await page.locator(`#chat .mes[mesid="${mesId}"] .mes_reasoning_edit`).click();
                        await expect(page.locator('.reasoning_edit_textarea')).toBeVisible();
                        try {
                            await openInfoTab(page, field.tab);
                            await fieldLocators(page, field.id).pencil.click();
                            await expectToast(page, MESSAGE_BLOCKED_TOAST);
                            await expectPreviewMode(page, field);
                        } finally {
                            await page.locator(`#chat .mes[mesid="${mesId}"] .mes_reasoning_edit_cancel`).click();
                        }
                    });
                });
            });

            test('another tab can\'t be opened while the field is being edited; its ✓ ✕ flash', async ({ page }) => {
                const nextTab = TABS[(TABS.indexOf(field.tab) + 1) % TABS.length];
                await withCharacter(page, field, 'original', async () => {
                    await enterEdit(page, field);
                    const f = fieldLocators(page, field.id);
                    await fillField(page, f, 'in progress');
                    const tabRadio = (/** @type {string} */ tab) => page.locator(`input[name="charInfoTabs_tab"][value="${tab}"]`);
                    await openInfoTab(page, nextTab);
                    await expect(f.panel).toHaveClass(/\bfield_edit_attention\b/);
                    await expect(tabRadio(field.tab)).toBeChecked();
                    await expect(tabRadio(nextTab)).not.toBeChecked();
                    await expectEditMode(page, field);

                    await tabRadio(field.tab).focus();
                    await page.keyboard.press('ArrowRight');
                    await expect(tabRadio(field.tab)).toBeChecked();

                    await page.evaluate((tab) => {
                        const radio = /** @type {HTMLInputElement} */ (document.querySelector(`#charInfoTabs input[name="charInfoTabs_tab"][value="${tab}"]`));
                        radio.checked = true;
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                    }, nextTab);
                    await expect(tabRadio(field.tab)).toBeChecked();
                    await expect(f.textarea).toHaveValue('in progress');

                    await f.cancel.click();
                    await openInfoTab(page, nextTab);
                    await expect(tabRadio(nextTab)).toBeChecked();
                });
            });

            test('select_selected_character does not overwrite the field in edit', async ({ page }) => {
                await withCharacter(page, field, 'original', async (avatar) => {
                    await enterEdit(page, field);
                    const f = fieldLocators(page, field.id);
                    await fillField(page, f, 'in progress');
                    await page.evaluate(async (avatar) => {
                        const { select_selected_character } = await import('/script.js');
                        select_selected_character(avatar);
                    }, avatar);
                    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);
                    await openInfoTab(page, field.tab);
                    await expectEditMode(page, field);
                    await expect(f.textarea).toHaveValue('in progress');
                    await f.cancel.click();
                });
            });

            test('an overswipe on the last chat message leaves the field edit intact', async ({ page }) => {
                await withCharacter(page, field, 'original', async () => {
                    await withDrawerPinned(page, async () => {
                        await expect(page.locator('#chat .mes')).toHaveCount(1, { timeout: 10000 });
                        const swipesBefore = await page.evaluate(() => {
                            // @ts-ignore
                            return SillyTavern.getContext().chat[0].swipes.length;
                        });
                        await enterEdit(page, field);
                        const f = fieldLocators(page, field.id);
                        await fillField(page, f, 'in progress');
                        await page.locator('#chat .mes[mesid="0"] .swipe_right').click();
                        await expect.poll(() => page.evaluate(() => {
                            // @ts-ignore
                            return SillyTavern.getContext().chat[0].swipes.length;
                        })).toBe(swipesBefore + 1);
                        await openInfoTab(page, field.tab);
                        await expectEditMode(page, field);
                        await expect(f.textarea).toHaveValue('in progress');
                        await f.cancel.click();
                    });
                });
            });

            for (const clickToEdit of [true, false]) {
                test(`clicking a link in the preview stays in the preview (click to edit ${clickToEdit ? 'on' : 'off'})`, async ({ page }) => {
                    await withCharacter(page, field, 'plain words\n\n[the link](https://example.invalid/page)', async () => {
                        await openInfoTab(page, field.tab);
                        const previous = await setPowerUserSetting(page, 'click_to_edit', clickToEdit);
                        try {
                            // The link must not leave the page under test; the app's own handlers still run.
                            await page.evaluate(() => document.addEventListener('click', (event) => {
                                if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
                            }, true));
                            const f = fieldLocators(page, field.id);
                            const link = f.preview.locator('a[href]');
                            await expect(link).toHaveText('the link');

                            await link.click();
                            await expectPreviewMode(page, field);
                            await link.dblclick();
                            await expectPreviewMode(page, field);

                            // Outside the link the preview still opens the editor.
                            const words = f.preview.getByText('plain words');
                            if (clickToEdit) {
                                await words.click();
                            } else {
                                await words.dblclick();
                            }
                            await expectEditMode(page, field);
                            await f.cancel.click();
                            await expectPreviewMode(page, field);
                        } finally {
                            await setPowerUserSetting(page, 'click_to_edit', previous);
                        }
                    });
                });
            }

            for (const clickToEdit of [true, false]) {
                test(`clicking an image in the preview shows it in the lightbox and stays in the preview (click to edit ${clickToEdit ? 'on' : 'off'})`, async ({ page }) => {
                    await withCharacter(page, field, 'plain words\n\n![the image](/img/ai4.png)', async () => {
                        await openInfoTab(page, field.tab);
                        const previous = await setPowerUserSetting(page, 'click_to_edit', clickToEdit);
                        try {
                            const f = fieldLocators(page, field.id);
                            const image = f.preview.locator('img');
                            await expect(image).toHaveCSS('cursor', 'pointer');
                            await expect(image).toBeVisible();
                            const enlarged = page.locator('.img_enlarged_container img.img_enlarged');

                            await image.click();
                            await expect(enlarged).toBeVisible();
                            await expect(enlarged).toHaveAttribute('src', /\/img\/ai4\.png$/);
                            await page.keyboard.press('Escape');
                            await expect(page.locator('.img_enlarged_container')).toHaveCount(0);
                            await expectPreviewMode(page, field);

                            // Outside the image the preview still opens the editor.
                            const words = f.preview.getByText('plain words');
                            if (clickToEdit) {
                                await words.click();
                            } else {
                                await words.dblclick();
                            }
                            await expectEditMode(page, field);
                            await f.cancel.click();
                            await expectPreviewMode(page, field);
                        } finally {
                            await setPowerUserSetting(page, 'click_to_edit', previous);
                        }
                    });
                });
            }

            for (const clickToEdit of [true, false]) {
                test(`double-clicking an image in the preview stays in the preview (click to edit ${clickToEdit ? 'on' : 'off'})`, async ({ page }) => {
                    await withCharacter(page, field, 'plain words\n\n![the image](/img/ai4.png)', async () => {
                        await openInfoTab(page, field.tab);
                        const previous = await setPowerUserSetting(page, 'click_to_edit', clickToEdit);
                        try {
                            const f = fieldLocators(page, field.id);
                            const image = f.preview.locator('img');
                            await expect(image).toBeVisible();

                            await image.dblclick();
                            await page.keyboard.press('Escape');
                            await expect(page.locator('.img_enlarged_container')).toHaveCount(0);
                            await expectPreviewMode(page, field);

                            await image.dispatchEvent('dblclick');
                            await expectPreviewMode(page, field);

                        } finally {
                            await setPowerUserSetting(page, 'click_to_edit', previous);
                        }
                    });
                });
            }

            test('an empty field shows the placeholder hint', async ({ page }) => {
                await withCharacter(page, field, '', async () => {
                    await openInfoTab(page, field.tab);
                    const f = fieldLocators(page, field.id);
                    await expect(f.preview).toHaveClass(/\bfield_preview_empty\b/);
                    const placeholder = String(await f.textarea.getAttribute('placeholder'));
                    expect(placeholder).not.toBe('');
                    await expect(f.preview).toHaveText(placeholder);
                });
            });

            test('a substituted macro value sits in span.macro-substituted', async ({ page }) => {
                await withCharacter(page, field, 'Hello {{char}}!', async (_avatar, name) => {
                    await openInfoTab(page, field.tab);
                    const spans = fieldLocators(page, field.id).preview.locator('span.macro-substituted');
                    await expect(spans).toHaveCount(1);
                    await expect(spans).toHaveText(name);
                });
            });

            for (const mode of ['preview', 'edit']) {
                test(`maximize moves the panel into an editor layer and back in ${mode} mode`, async ({ page }) => {
                    await withCharacter(page, field, 'original', async () => {
                        if (mode === 'edit') {
                            await enterEdit(page, field);
                        } else {
                            await openInfoTab(page, field.tab);
                        }
                        const f = fieldLocators(page, field.id);
                        const inLayer = page.locator('#movingDivs > .editorLayer .char_info_tab_panel', { has: f.textarea });
                        const inDrawer = page.locator('#char-info-panel .char_info_tab_panel', { has: f.textarea });

                        await f.maximize.click();
                        await expect(f.panel).toHaveClass(/\bmaximized\b/);
                        await expect(inLayer).toBeVisible();
                        await expect(inDrawer).toHaveCount(0);
                        await expect(page.locator('#char-info-panel .char_info_tab_panel_placeholder')).toBeVisible();
                        await expect(f.maximize).toHaveClass(/\bfa-minimize\b/);
                        await expect(f.maximize).not.toHaveClass(/\bfa-maximize\b/);
                        await expect(f.maximize).toHaveAttribute('title', 'Restore');

                        await f.maximize.click();
                        await expect(f.panel).not.toHaveClass(/\bmaximized\b/);
                        await expect(inDrawer).toHaveCount(1);
                        await expect(page.locator('.editorLayer')).toHaveCount(0);
                        await expect(page.locator('.char_info_tab_panel_placeholder')).toHaveCount(0);
                        await expect(f.maximize).toHaveClass(/\bfa-maximize\b/);
                        await expect(f.maximize).not.toHaveClass(/\bfa-minimize\b/);
                        await expect(f.maximize).toHaveAttribute('title', 'Expand the editor');

                        if (mode === 'edit') {
                            await expectEditMode(page, field);
                            await f.cancel.click();
                        }
                    });
                });
            }
        });
    }

    for (const field of FIELDS.filter(x => x.id !== 'greeting_field')) {
        test(`${field.id}: code writing the field outside edit mode, as upstream extensions do, saves it and updates the preview`, async ({ page }) => {
            await withCharacter(page, field, 'original', async (avatar) => {
                await openInfoTab(page, field.tab);
                await page.evaluate(id => $(`#${id}`).val('written by code').trigger('input'), field.id);
                await expectPreviewMode(page, field);
                await expect(fieldLocators(page, field.id).preview).toContainText('written by code');
                await expect.poll(async () => storedValue(await fetchStoredCharacter(page, avatar), field), { timeout: 10000 }).toBe('written by code');
            });
        });
    }

    test('code writing a field during an edit stores its value and keeps the user\'s typing in the editor', async ({ page }) => {
        const field = FIELDS.find(x => x.id === 'description_textarea');
        await withCharacter(page, field, 'original', async (avatar) => {
            await openInfoTab(page, field.tab);
            const f = fieldLocators(page, field.id);
            await f.pencil.click();
            await expectEditMode(page, field);
            await fillField(page, f, 'typed by the user');
            await page.evaluate(id => $(`#${id}`).val('written by code').trigger('input'), field.id);

            await expect(f.textarea).toHaveValue('typed by the user');
            await expectEditMode(page, field);
            await expect.poll(async () => storedValue(await fetchStoredCharacter(page, avatar), field), { timeout: 10000 }).toBe('written by code');

            await f.cancel.click();
            await expectPreviewMode(page, field);
            await expect(f.preview).toContainText('written by code');
        });
    });

    test.describe('rendering', () => {
        test('Greeting renders as chat message 0, HTML included', async ({ page }) => {
            const field = FIELDS.find(x => x.id === 'greeting_field');
            await withCharacter(page, field, '<b>bold</b> and **strong**', async () => {
                await openInfoTab(page, field.tab);
                const preview = fieldLocators(page, field.id).preview;
                await expect(preview).toHaveClass(/\bmes_text\b/);
                await expect(preview.locator('b')).toHaveText('bold');
                await expect(preview.locator('strong')).toHaveText('strong');
                await expect(preview).not.toContainText('<b>');
            });
        });

        test('Creator\'s Notes render markdown and HTML', async ({ page }) => {
            const field = FIELDS.find(x => x.id === 'creator_notes_textarea');
            await withCharacter(page, field, '<b>bold</b> and **strong**', async () => {
                await openInfoTab(page, field.tab);
                const preview = fieldLocators(page, field.id).preview;
                await expect(preview.locator('b')).toHaveText('bold');
                await expect(preview.locator('strong')).toHaveText('strong');
                await expect(preview).not.toContainText('<b>');
            });
        });

        for (const id of ['description_textarea', 'system_prompt_textarea', 'post_history_instructions_textarea', 'personality_textarea', 'scenario_pole', 'depth_prompt_prompt', 'mes_example_textarea']) {
            test(`${id} renders markdown with raw HTML tags shown literally`, async ({ page }) => {
                const field = FIELDS.find(x => x.id === id);
                const text = '<b>literal</b> and **strong** and `<i>code</i>`\n\n> quoted';
                await withCharacter(page, field, text, async () => {
                    await openInfoTab(page, field.tab);
                    const preview = fieldLocators(page, field.id).preview;
                    await expect(preview).toContainText('<b>literal</b>');
                    await expect(preview.locator('b')).toHaveCount(0);
                    await expect(preview.locator('strong')).toHaveText('strong');
                    await expect(preview.locator('code')).toHaveText('<i>code</i>');
                    await expect(preview.locator('i')).toHaveCount(0);
                    await expect(preview.locator('blockquote')).toHaveText('quoted');
                });
            });
        }

        for (const [id, engine] of [['creator_notes_textarea', true], ['description_textarea', true], ['description_textarea', false]]) {
            test(`${id}, ${engine ? 'new' : 'old'} macro engine: the preview fills in safe macros and never runs ones with side effects or randomness`, async ({ page }) => {
                const field = FIELDS.find(x => x.id === id);
                const previousEngine = await setPowerUserSetting(page, 'experimental_macro_engine', engine);
                const key = `pv${stamp().replace(/\D/g, '')}`;
                // The old engine shows a popup for nested macros, so only the new engine gets one.
                const nested = engine ? ' {{reverse::{{random::cc::dd}}}}' : '';
                const text = `{{setvar::${key}::set}}{{incvar::${key}n}}[{{char}}] {{random::aa::bb}}${nested}`;
                await withCharacter(page, field, text, async (_avatar, name) => {
                    await openInfoTab(page, field.tab);
                    const preview = fieldLocators(page, field.id).preview;
                    await expect(preview.locator('.macro-substituted').first()).toHaveText(name);
                    await expect(preview.locator('.macro-raw')).toHaveText([
                        `{{setvar::${key}::set}}`,
                        `{{incvar::${key}n}}`,
                        '{{random::aa::bb}}',
                        ...(engine ? ['{{reverse::{{random::cc::dd}}}}'] : []),
                    ]);
                    for (let i = 0; i < 3; i++) {
                        await enterEdit(page, field);
                        await fieldLocators(page, field.id).cancel.click();
                        await expectPreviewMode(page, field);
                    }
                    const vars = await page.evaluate((k) => {
                        // @ts-ignore
                        const ctx = SillyTavern.getContext();
                        return [Boolean(ctx.variables.local.has(k)), Boolean(ctx.variables.local.has(`${k}n`))];
                    }, key);
                    expect(vars).toEqual([false, false]);
                });
                await setPowerUserSetting(page, 'experimental_macro_engine', previousEngine);
            });
        }

        const TEXT_METRICS = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'word-break', 'overflow-wrap'];

        for (const field of FIELDS) {
            test(`${field.id}: the textarea in edit mode has the preview's text metrics`, async ({ page }) => {
                await withCharacter(page, field, 'some text', async () => {
                    await openInfoTab(page, field.tab);
                    const f = fieldLocators(page, field.id);
                    const read = (/** @type {import('@playwright/test').Locator} */ locator) => locator.evaluate((el, props) => {
                        const style = getComputedStyle(el);
                        return Object.fromEntries(props.map(p => [p, style.getPropertyValue(p)]));
                    }, TEXT_METRICS);
                    const preview = await read(f.preview);
                    await enterEdit(page, field);
                    expect(await read(f.textarea)).toEqual(preview);
                    await f.cancel.click();
                });
            });
        }

        test('a chat message being edited keeps the message text\'s metrics', async ({ page }) => {
            const field = FIELDS.find(x => x.id === 'description_textarea');
            await withCharacter(page, field, 'x', async () => {
                await withDrawerPinned(page, async () => {
                    const mesText = page.locator('#chat .mes[mesid="0"] .mes_text');
                    await expect(mesText).toHaveCount(1, { timeout: 10000 });
                    const read = (/** @type {import('@playwright/test').Locator} */ locator) => locator.evaluate((el, props) => {
                        const style = getComputedStyle(el);
                        return Object.fromEntries(props.map(p => [p, style.getPropertyValue(p)]));
                    }, TEXT_METRICS);
                    const before = await read(mesText);
                    await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
                    await expect(page.locator('#curEditTextarea')).toBeVisible();
                    expect(await read(page.locator('#curEditTextarea'))).toEqual(before);
                    await page.locator('#chat .mes[mesid="0"] .mes_edit_cancel').click();
                });
            });
        });

        // The chat itself runs the greeting's macros when it shows it, so only the preview's rendering is checked.
        test('greeting_field: the preview shows macros with side effects or randomness as written', async ({ page }) => {
            const field = FIELDS.find(x => x.id === 'greeting_field');
            await withCharacter(page, field, '[{{char}}] {{random::aa::bb}}', async (_avatar, name) => {
                await openInfoTab(page, field.tab);
                const preview = fieldLocators(page, field.id).preview;
                await expect(preview.locator('.macro-substituted').first()).toHaveText(name);
                await expect(preview.locator('.macro-raw')).toHaveText(['{{random::aa::bb}}']);
            });
        });
    });

    test('Escape with no field being edited still closes the character info drawer', async ({ page }) => {
        const field = FIELDS.find(x => x.id === 'description_textarea');
        await withCharacter(page, field, 'original', async () => {
            await openInfoTab(page, field.tab);
            await expect(page.locator('#char-info-panel')).toHaveClass(/\bopenDrawer\b/);
            await page.evaluate(() => (/** @type {HTMLElement} */ (document.activeElement))?.blur());
            await page.keyboard.press('Escape');
            await expect(page.locator('#char-info-panel')).toHaveClass(/\bclosedDrawer\b/);
        });
    });
});

test.describe('expanded editor layer', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => awaitAppReady(page));

    const description = FIELDS.find(x => x.id === 'description_textarea');
    const layer = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#movingDivs > .editorLayer');

    /**
     * @param {import('@playwright/test').Page} page
     * @param {number} x
     * @param {number} y
     * @returns {Promise<string>} The id of the layer the page shows at that point: the editor layer, the chat, or a drawer.
     */
    function layerAt(page, x, y) {
        return page.evaluate(([x, y]) => {
            const hit = document.elementFromPoint(x, y);
            if (hit?.closest('.editorLayer')) return 'editor';
            return hit?.closest('#sheld, .drawer-content')?.id ?? '';
        }, [x, y]);
    }

    test('spans the three columns capped to Chat Width Max, with no backdrop and no modal', async ({ page }) => {
        await withCharacter(page, description, 'some text', async () => {
            await openInfoTab(page, description.tab);
            await fieldLocators(page, description.id).maximize.click();
            await expect(layer(page)).toBeVisible();
            const { box, expectedWidth, viewport } = await page.evaluate(() => {
                const el = /** @type {HTMLElement} */ (document.querySelector('#movingDivs > .editorLayer'));
                const probe = document.createElement('div');
                probe.style.width = 'min(var(--besideDrawerBarWidth), var(--chatWidthMax, 120ch))';
                probe.style.position = 'fixed';
                document.body.appendChild(probe);
                const expectedWidth = probe.getBoundingClientRect().width;
                probe.remove();
                const r = el.getBoundingClientRect();
                return { box: { left: r.left, right: r.right, width: r.width }, expectedWidth, viewport: window.innerWidth };
            });
            expect(Math.abs(box.width - expectedWidth)).toBeLessThan(2);
            expect(Math.abs(box.left - (viewport - box.right))).toBeLessThan(2);
            await expect(page.locator('dialog[open]')).toHaveCount(0);
        });
    });

    test('Escape and the button close it; in edit mode Escape first ends the edit', async ({ page }) => {
        await withCharacter(page, description, 'original', async () => {
            const f = fieldLocators(page, description.id);
            await openInfoTab(page, description.tab);
            await f.maximize.click();
            await expect(layer(page)).toBeVisible();
            await layer(page).locator('.editorLayerClose').click();
            await expect(layer(page)).toHaveCount(0);

            await f.maximize.click();
            await layer(page).locator('.editorLayerClose').focus();
            await page.keyboard.press('Escape');
            await expect(layer(page)).toHaveCount(0);

            await enterEdit(page, description);
            await f.maximize.click();
            await f.textarea.focus();
            await page.keyboard.press('Escape');
            await expect(f.panel).not.toHaveClass(/\bfield_editing\b/);
            await expect(layer(page)).toBeVisible();
            await layer(page).locator('.editorLayerClose').focus();
            await page.keyboard.press('Escape');
            await expect(layer(page)).toHaveCount(0);
        });
    });

    test('typing, the cursor and the edit survive maximize and restore', async ({ page }) => {
        await withCharacter(page, description, 'original', async () => {
            const f = fieldLocators(page, description.id);
            await enterEdit(page, description);
            await fillField(page, f, 'typed text');
            await f.textarea.evaluate(el => (/** @type {HTMLTextAreaElement} */ (el)).setSelectionRange(5, 5));
            await f.maximize.click();
            await expect(layer(page).locator(`#${description.id}`)).toBeVisible();
            await page.keyboard.type('X');
            await expect(f.textarea).toHaveValue('typedX text');
            await f.maximize.click();
            await expect(layer(page)).toHaveCount(0);
            await expectEditMode(page, description);
            await expect(f.textarea).toHaveValue('typedX text');
            await f.cancel.click();
        });
    });

    test('with stacked drawers on, the chat and a drawer come forward over it and it comes back when clicked', async ({ page }) => {
        await setStackedDrawers(page, true);
        try {
            await withCharacter(page, description, 'original', async () => {
                await openInfoTab(page, description.tab);
                await fieldLocators(page, description.id).maximize.click();
                await expect(layer(page)).toBeVisible();
                const box = await layer(page).boundingBox();
                const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
                await expect.poll(() => layerAt(page, center.x, center.y)).toBe('editor');

                // The chat is covered by the layer; its icon brings it forward.
                await page.locator('#chatDrawerIcon').click();
                await expect.poll(() => layerAt(page, center.x, center.y)).toBe('sheld');

                // A click on the layer's visible part brings it back.
                await page.mouse.click(box.x + 5, box.y + box.height / 2);
                await expect.poll(() => layerAt(page, center.x, center.y)).toBe('editor');

                // A click on the character info drawer's visible part brings that forward over the layer.
                // An empty spot near the drawer's bottom, past the layer's right edge.
                const drawer = await page.locator('#char-info-panel').boundingBox();
                const strip = { x: Math.max(drawer.x, box.x + box.width) + 5, y: drawer.y + drawer.height - 10 };
                await page.mouse.click(strip.x, strip.y);
                const overlap = { x: Math.max(drawer.x, box.x) + 5, y: strip.y };
                await expect.poll(() => layerAt(page, overlap.x, overlap.y)).toBe('char-info-panel');

                await page.mouse.click(box.x + 5, box.y + box.height / 2);
                await expect.poll(() => layerAt(page, overlap.x, overlap.y)).toBe('editor');
                await layer(page).locator('.editorLayerClose').click();
            });
        } finally {
            await setStackedDrawers(page, false);
        }
    });

    test('an .editor_maximize field opens the same layer, kept in sync, and Escape returns to the field', async ({ page }) => {
        // A field and button of its own, as an extension would add them, so the test doesn't depend on which drawer holds one.
        await page.evaluate(() => {
            const holder = document.createElement('div');
            holder.id = 'expand_test_holder';
            holder.style.cssText = 'position: fixed; top: 60px; left: 10px; z-index: 5000;';
            holder.innerHTML = '<i class="editor_maximize fa-solid fa-maximize" data-for="expand_test_textarea"></i><textarea id="expand_test_textarea">calm</textarea>';
            document.body.append(holder);
        });
        try {
            await page.locator('.editor_maximize[data-for="expand_test_textarea"]').click();
            const editor = layer(page).locator('textarea.maximized_textarea');
            await expect(editor).toBeVisible();
            await expect(page.locator('dialog[open]')).toHaveCount(0);
            await expect(editor).toHaveValue('calm');
            await editor.fill('calm and kind');
            await expect(page.locator('#expand_test_textarea')).toHaveValue('calm and kind');
            await page.keyboard.press('Escape');
            await expect(layer(page)).toHaveCount(0);
            await expect(page.locator('#expand_test_textarea')).toBeFocused();
        } finally {
            await page.evaluate(() => document.getElementById('expand_test_holder')?.remove());
        }
    });
});
