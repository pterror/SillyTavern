import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Upstream's exports that take a character index (a position in `getContext().characters`), called the way an
// upstream extension calls them: with `getContext().characterId` (an index string), with a number, and with the
// fork's avatar key. Each form must have the same effect; a miss follows upstream's miss behaviour.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const PAIR_MISMATCH_WARNING = 'do not resolve to the same character';
const LEGACY_INDEX_WARNING = 'called with a legacy character index';
// No test creates this many characters, so it is never a position in `getContext().characters`.
const MISSING_INDEX = 999999;

function stamp() {
    return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Creates a character through the API.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} description
 * @returns {Promise<string>} The avatar filename.
 */
async function createCharacter(page, name, description = 'stored description') {
    return page.evaluate(async ({ name, description }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('description', description);
        form.set('first_mes', `Hello from ${name}`);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, description });
}

/**
 * Creates characters, then reloads the client's character list so they are all in `getContext().characters`.
 * @param {import('@playwright/test').Page} page
 * @param {string} prefix
 * @param {number} count
 * @returns {Promise<string[]>} Avatars, in creation order.
 */
async function createCharacters(page, prefix, count) {
    const s = stamp();
    const avatars = [];
    for (let i = 0; i < count; i++) {
        avatars.push(await createCharacter(page, `${prefix}${i}-${s}`, `description ${i} ${s}`));
    }
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
    });
    return avatars;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} avatars
 */
async function deleteCharacters(page, avatars) {
    await page.evaluate(async (avatars) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        for (const avatar of avatars) {
            await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
        }
    }, avatars);
}

/**
 * Selects the character (as a click on its list row does) and waits for its chat.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function selectCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
}

/**
 * Selects the character and returns `getContext().characterId`, the index string an upstream extension reads.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<string>}
 */
async function indexOf(page, avatar) {
    await selectCharacter(page, avatar);
    const characterId = await page.evaluate(() => {
        // @ts-ignore
        return SillyTavern.getContext().characterId;
    });
    expect(typeof characterId).toBe('string');
    expect(characterId).toMatch(/^(0|[1-9]\d*)$/);
    return characterId;
}

/**
 * Checks that the index still names the character in `getContext().characters` (nothing shifted it since).
 * @param {import('@playwright/test').Page} page
 * @param {string} index
 * @param {string} avatar
 */
async function expectIndexNames(page, index, avatar) {
    const named = await page.evaluate((index) => {
        // @ts-ignore
        return SillyTavern.getContext().characters[Number(index)]?.avatar;
    }, index);
    expect(named).toBe(avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<{ok: boolean, body: any}>} The card as stored on the server.
 */
async function fetchStoredCharacter(page, avatar) {
    return page.evaluate(async (avatarUrl) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatarUrl }) });
        let body = null;
        try { body = await response.json(); } catch { /* not JSON */ }
        return { ok: response.ok, body };
    }, avatar);
}

/**
 * Saves a one-message chat for the character under the given name.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {string} fileName
 */
async function saveChat(page, avatar, fileName) {
    await page.evaluate(async ({ avatar, fileName }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const chat = [{ chat_metadata: {} }, { name: 'User', is_user: true, mes: `message in ${fileName}`, extra: {} }];
        const response = await fetch('/api/chats/save', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, ch_name: avatar, file_name: fileName, chat, force: true }) });
        if (!response.ok) throw new Error(`chat save failed: ${response.status}`);
    }, { avatar, fileName });
}

/**
 * The character's chat names, as the server lists them (without .jsonl).
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<string[]>}
 */
async function listChatNames(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/chats', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        const data = await response.json();
        return Object.values(data).map((/** @type {any} */ chat) => String(chat.file_name).replace(/\.jsonl$/, '')).sort();
    }, avatar);
}

/**
 * Every console.warn from here on.
 * @param {import('@playwright/test').Page} page
 * @returns {string[]}
 */
function collectWarnings(page) {
    const warnings = [];
    page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
    });
    return warnings;
}

/**
 * Every POST to the given path from here on, with its JSON body.
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @returns {any[]}
 */
function recordPosts(page, path) {
    const bodies = [];
    page.on('request', (request) => {
        if (request.method() !== 'POST' || new URL(request.url()).pathname !== path) return;
        let body;
        try { body = request.postDataJSON(); } catch { body = null; }
        bodies.push(body);
    });
    return bodies;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {any} ref
 */
async function deleteVia(page, ref) {
    await page.evaluate(async (ref) => {
        const { handleDeleteCharacter } = await import('/script.js');
        await handleDeleteCharacter(ref, true);
    }, ref);
}

test.describe('positional character parameters (#1-#8)', () => {
    test.beforeEach(testSetup.awaitST);

    test('#1 deleteCharacterChatByName deletes the named chat for an index string, a number and an avatar', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxDelChat', 2);
        try {
            for (const name of ['chat-a', 'chat-b', 'chat-c', 'chat-keep']) {
                await saveChat(page, target, name);
            }
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);

            const calls = [['chat-a', index], ['chat-b', Number(index)], ['chat-c', target]];
            let expected = await listChatNames(page, target);
            expect(expected).toEqual(expect.arrayContaining(['chat-a', 'chat-b', 'chat-c', 'chat-keep']));
            for (const [fileName, ref] of calls) {
                await page.evaluate(async ({ ref, fileName }) => {
                    const { deleteCharacterChatByName } = await import('/script.js');
                    await deleteCharacterChatByName(ref, fileName);
                }, { ref, fileName });
                expected = expected.filter(name => name !== fileName);
                expect(await listChatNames(page, target)).toEqual(expected);
            }
            expect(expected).toContain('chat-keep');
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('#2 getCharacterAvatar returns the same avatar URL for an index string, a number and an avatar', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxAvatar', 2);
        try {
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);

            const urls = await page.evaluate(async ({ refs }) => {
                const { getCharacterAvatar } = await import('/script.js');
                return refs.map(ref => getCharacterAvatar(ref));
            }, { refs: [index, Number(index), target] });
            expect(urls).toEqual([`characters/${target}`, `characters/${target}`, `characters/${target}`]);
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('#3 getCharacterSource returns the same source for an index string, a number and an avatar', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxSource', 2);
        try {
            const chubPath = `someone/idx-source-${stamp()}`;
            await page.evaluate(async ({ avatar, chubPath }) => {
                // @ts-ignore
                const headers = SillyTavern.getContext().getRequestHeaders();
                const response = await fetch('/api/characters/merge-attributes', { method: 'POST', headers, body: JSON.stringify({ avatar, data: { extensions: { chub: { full_path: chubPath } } } }) });
                if (!response.ok) throw new Error(`merge failed: ${response.status}`);
                const { getOneCharacter } = await import('/script.js');
                await getOneCharacter(avatar);
            }, { avatar: target, chubPath });
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);

            const sources = await page.evaluate(async ({ refs }) => {
                const { getCharacterSource } = await import('/script.js');
                return refs.map(ref => getCharacterSource(ref));
            }, { refs: [index, Number(index), target] });
            const expected = `https://chub.ai/characters/${chubPath}`;
            expect(sources).toEqual([expected, expected, expected]);
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('#4 getPastCharacterChats lists the same chats for an index string, a number and an avatar', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxPastChats', 2);
        try {
            await saveChat(page, target, 'past-one');
            await saveChat(page, target, 'past-two');
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);

            const lists = await page.evaluate(async ({ refs }) => {
                const { getPastCharacterChats } = await import('/script.js');
                const results = [];
                for (const ref of refs) {
                    const chats = await getPastCharacterChats(ref);
                    results.push(chats.map(chat => String(chat.file_name).replace(/\.jsonl$/, '')).sort());
                }
                return results;
            }, { refs: [index, Number(index), target] });
            const expected = await listChatNames(page, target);
            expect(expected).toEqual(expect.arrayContaining(['past-one', 'past-two']));
            expect(lists).toEqual([expected, expected, expected]);
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('#5 handleDeleteCharacter deletes the named character for an index string, a number and an avatar', async ({ page }) => {
        const [bystander, byIndexString, byNumber, byAvatar] = await createCharacters(page, 'IdxDelete', 4);
        try {
            // Each deletion shifts later indices, so each index is read just before its call.
            const byIndexStringRef = await indexOf(page, byIndexString);
            await deleteVia(page, byIndexStringRef);
            expect((await fetchStoredCharacter(page, byIndexString)).ok).toBe(false);

            const byNumberRef = Number(await indexOf(page, byNumber));
            await expectIndexNames(page, String(byNumberRef), byNumber);
            await deleteVia(page, byNumberRef);
            expect((await fetchStoredCharacter(page, byNumber)).ok).toBe(false);

            // With nothing selected, deleteCharacter first asks to close the temporary chat.
            await selectCharacter(page, bystander);
            await deleteVia(page, byAvatar);
            expect((await fetchStoredCharacter(page, byAvatar)).ok).toBe(false);

            expect((await fetchStoredCharacter(page, bystander)).ok).toBe(true);
        } finally {
            await deleteCharacters(page, [bystander, byIndexString, byNumber, byAvatar]);
        }
    });

    test('#5 handleDeleteCharacter with an argument that names no character deletes nothing', async ({ page }) => {
        const [current, other] = await createCharacters(page, 'IdxDeleteMiss', 2);
        try {
            await selectCharacter(page, current);
            const deletes = recordPosts(page, '/api/characters/delete');
            const before = await page.evaluate(() => {
                // @ts-ignore
                return SillyTavern.getContext().characters.length;
            });

            for (const ref of [String(MISSING_INDEX), MISSING_INDEX, 'no-such-character.png', undefined]) {
                await deleteVia(page, ref);
            }
            await page.waitForTimeout(1000);

            expect(deletes).toEqual([]);
            expect((await fetchStoredCharacter(page, current)).ok).toBe(true);
            expect((await fetchStoredCharacter(page, other)).ok).toBe(true);
            const after = await page.evaluate(() => {
                // @ts-ignore
                const ctx = SillyTavern.getContext();
                return { length: ctx.characters.length, avatar: ctx.characterAvatar };
            });
            expect(after).toEqual({ length: before, avatar: current });
        } finally {
            await deleteCharacters(page, [current, other]);
        }
    });

    test('#6 select_selected_character opens the editor on the same character for an index string, a number and an avatar', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxEditor', 2);
        try {
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);
            const targetName = (await fetchStoredCharacter(page, target)).body.name;

            for (const ref of [index, Number(index), target]) {
                await page.evaluate(() => {
                    // @ts-ignore
                    $('#avatar_url_pole').val('');
                    // @ts-ignore
                    $('#character_name_pole').val('');
                });
                await page.evaluate(async (ref) => {
                    const { select_selected_character } = await import('/script.js');
                    select_selected_character(ref);
                }, ref);
                await expect(page.locator('#avatar_url_pole')).toHaveValue(target);
                await expect(page.locator('#character_name_pole')).toHaveValue(targetName);
                await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'editcharacter');
            }
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('#6 select_selected_character throws on a miss before any editor setup', async ({ page }) => {
        const [current] = await createCharacters(page, 'IdxEditorMiss', 1);
        try {
            await selectCharacter(page, current);
            await page.locator('#rm_button_create').click();
            await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'createcharacter');
            await page.evaluate(() => {
                // @ts-ignore
                $('#character_name_pole').val('typed before the miss');
                // @ts-ignore
                const ctx = SillyTavern.getContext();
                // @ts-ignore
                window.__editorOpened = [];
                // @ts-ignore
                ctx.eventSource.on(ctx.eventTypes.CHARACTER_EDITOR_OPENED, (...args) => window.__editorOpened.push(args));
            });
            const snapshot = () => page.evaluate(() => ({
                // @ts-ignore
                actiontype: $('#form_create').attr('actiontype'),
                // @ts-ignore
                deleteButton: $('#delete_button').css('display'),
                // @ts-ignore
                exportButton: $('#export_button').css('display'),
                // @ts-ignore
                dupeButton: $('#dupe_button').css('display'),
                // @ts-ignore
                createButtonValue: $('#create_button').attr('value'),
                // @ts-ignore
                createButtonLabel: $('#create_button_label').css('display'),
                // @ts-ignore
                name: $('#character_name_pole').val(),
                // @ts-ignore
                avatarUrl: $('#avatar_url_pole').val(),
                // @ts-ignore
                jsonData: $('#character_json_data').val(),
                // @ts-ignore
                navbarName: $('#rm_button_selected_ch').children('h2').text(),
            }));
            const before = await snapshot();

            for (const ref of [String(MISSING_INDEX), MISSING_INDEX, 'no-such-character.png']) {
                const thrown = await page.evaluate(async (ref) => {
                    const { select_selected_character } = await import('/script.js');
                    try {
                        select_selected_character(ref);
                        return null;
                    } catch (error) {
                        return { name: error.name, message: error.message };
                    }
                }, ref);
                expect(thrown).toEqual({ name: 'TypeError', message: expect.stringContaining(JSON.stringify(ref)) });
                expect(await snapshot()).toEqual(before);
            }
            // @ts-ignore
            expect(await page.evaluate(() => window.__editorOpened)).toEqual([]);
        } finally {
            await deleteCharacters(page, [current]);
        }
    });

    test('#7 unshallowCharacter loads the same shallow character for an index string, a number and an avatar', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxUnshallow', 2);
        try {
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);
            const gets = recordPosts(page, '/api/characters/get');

            for (const ref of [index, Number(index), target]) {
                gets.length = 0;
                const shallowAfter = await page.evaluate(async ({ ref, avatar }) => {
                    const { unshallowCharacter } = await import('/script.js');
                    // @ts-ignore
                    const ctx = SillyTavern.getContext();
                    ctx.getCharacterByAvatar(avatar).shallow = true;
                    await unshallowCharacter(ref);
                    return ctx.getCharacterByAvatar(avatar).shallow;
                }, { ref, avatar: target });
                expect(shallowAfter).toBe(false);
                expect(gets).toEqual([{ avatar_url: target }]);
            }
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('#8 updateRemoteChatName updates the same character\'s pointer for an index string, a number and an avatar', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxRemoteName', 2);
        try {
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);

            const calls = [['pointer-by-index-string', index], ['pointer-by-number', Number(index)], ['pointer-by-avatar', target]];
            for (const [newName, ref] of calls) {
                const local = await page.evaluate(async ({ ref, newName, avatar }) => {
                    const { updateRemoteChatName } = await import('/script.js');
                    await updateRemoteChatName(ref, newName);
                    // @ts-ignore
                    return SillyTavern.getContext().getCharacterByAvatar(avatar).chat;
                }, { ref, newName, avatar: target });
                expect(local).toBe(newName);
                expect((await fetchStoredCharacter(page, target)).body.chat).toBe(newName);
            }
            expect((await fetchStoredCharacter(page, current)).body.chat).not.toBe('pointer-by-avatar');
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });
});

test.describe('#10 Generate force_chid', () => {
    test.beforeEach(testSetup.awaitST);

    /**
     * Creates two characters and a group of both, captures their indices, and opens the group. Generation is
     * made to reach the group wrapper (online) and to stop right after it drafts a member (offline again, so the
     * member's own Generate returns before any backend call). Drafted members are recorded.
     * @param {import('@playwright/test').Page} page
     */
    async function setUpGroup(page) {
        const [first, second] = await createCharacters(page, 'IdxGroup', 2);
        const groupId = await page.evaluate(async ({ members, name }) => {
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            const response = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name, members }) });
            if (!response.ok) throw new Error(`group create failed: ${response.status}`);
            const data = await response.json();
            const { groupsStore } = await import('/scripts/group-chats.js');
            await ctx.getCharacters({ silentGroups: true });
            groupsStore.reportCreated(String(data.id));
            return String(data.id);
        }, { members: [first, second], name: `IdxGroup-${stamp()}` });
        const firstIndex = await indexOf(page, first);
        const secondIndex = await indexOf(page, second);
        await page.evaluate(async (groupId) => {
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            const { openGroupById } = await import('/scripts/group-chats.js');
            await openGroupById(groupId);
            const { setOnlineStatus } = await import('/script.js');
            // @ts-ignore
            window.__drafted = [];
            ctx.eventSource.on(ctx.eventTypes.GROUP_MEMBER_DRAFTED, (member) => {
                // @ts-ignore
                window.__drafted.push(member);
                setOnlineStatus('no_connection');
            });
        }, groupId);
        await expect.poll(() => page.evaluate(() => {
            // @ts-ignore
            return SillyTavern.getContext().groupId;
        })).toBe(groupId);
        await expectIndexNames(page, firstIndex, first);
        await expectIndexNames(page, secondIndex, second);
        return { first, second, firstIndex, secondIndex, groupId };
    }

    /**
     * @param {import('@playwright/test').Page} page
     * @param {string} groupId
     * @param {string[]} avatars
     */
    async function tearDownGroup(page, groupId, avatars) {
        await page.evaluate(async (id) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            await fetch('/api/groups/delete', { method: 'POST', headers, body: JSON.stringify({ id }) });
        }, groupId);
        await deleteCharacters(page, avatars);
    }

    /**
     * Calls Generate with these options and reports the members drafted and whether it threw.
     * @param {import('@playwright/test').Page} page
     * @param {object} options
     * @returns {Promise<{drafted: string[], error: null|{name: string, message: string}}>}
     */
    async function generateWith(page, options) {
        return page.evaluate(async (options) => {
            const { Generate, setOnlineStatus } = await import('/script.js');
            // @ts-ignore
            window.__drafted = [];
            setOnlineStatus('Valid');
            let error = null;
            try {
                await Generate('normal', options);
            } catch (e) {
                error = { name: e.name, message: e.message };
            } finally {
                setOnlineStatus('no_connection');
            }
            // @ts-ignore
            return { drafted: window.__drafted, error };
        }, options);
    }

    test('in a group, a numeric force_chid and force_avatar draft the same member', async ({ page }) => {
        const { first, second, secondIndex, groupId } = await setUpGroup(page);
        try {
            const warnings = collectWarnings(page);
            expect(await generateWith(page, { force_chid: Number(secondIndex) })).toEqual({ drafted: [second], error: null });
            expect(await generateWith(page, { force_avatar: second })).toEqual({ drafted: [second], error: null });
            expect(await generateWith(page, { force_chid: Number(secondIndex), force_avatar: second })).toEqual({ drafted: [second], error: null });
            expect(warnings.filter(text => text.includes(PAIR_MISMATCH_WARNING))).toEqual([]);
        } finally {
            await tearDownGroup(page, groupId, [first, second]);
        }
    });

    test('in a group, a string or null force_chid is ignored', async ({ page }) => {
        const { first, second, secondIndex, groupId } = await setUpGroup(page);
        try {
            const warnings = collectWarnings(page);
            // `getContext().characterId` is an index string: force_chid takes numbers only, so force_avatar decides.
            expect(await generateWith(page, { force_chid: secondIndex, force_avatar: first })).toEqual({ drafted: [first], error: null });
            expect(await generateWith(page, { force_chid: second, force_avatar: first })).toEqual({ drafted: [first], error: null });
            expect(await generateWith(page, { force_chid: String(MISSING_INDEX), force_avatar: first })).toEqual({ drafted: [first], error: null });
            expect(await generateWith(page, { force_chid: null, force_avatar: first })).toEqual({ drafted: [first], error: null });
            expect(warnings.filter(text => text.includes(PAIR_MISMATCH_WARNING))).toEqual([]);
        } finally {
            await tearDownGroup(page, groupId, [first, second]);
        }
    });

    test('in a group, a numeric force_chid that names no character throws', async ({ page }) => {
        const { first, second, groupId } = await setUpGroup(page);
        try {
            expect(await generateWith(page, { force_chid: MISSING_INDEX })).toEqual({
                drafted: [],
                error: { name: 'TypeError', message: `force_chid ${MISSING_INDEX} does not name a character` },
            });
        } finally {
            await tearDownGroup(page, groupId, [first, second]);
        }
    });

    test('in a group, force_chid and force_avatar naming different characters throw, with one warning naming both', async ({ page }) => {
        const { first, second, secondIndex, groupId } = await setUpGroup(page);
        try {
            const warnings = collectWarnings(page);
            expect(await generateWith(page, { force_chid: Number(secondIndex), force_avatar: first })).toEqual({
                drafted: [],
                error: { name: 'TypeError', message: `force_chid ${secondIndex} does not name a character` },
            });
            await expect.poll(() => warnings.filter(text => text.includes(PAIR_MISMATCH_WARNING)).length).toBe(1);
            await page.waitForTimeout(300);
            const mismatch = warnings.filter(text => text.includes(PAIR_MISMATCH_WARNING));
            expect(mismatch).toHaveLength(1);
            expect(mismatch[0]).toContain(secondIndex);
            expect(mismatch[0]).toContain(first);
        } finally {
            await tearDownGroup(page, groupId, [first, second]);
        }
    });

    test('outside a group, force_chid is ignored', async ({ page }) => {
        const [current] = await createCharacters(page, 'IdxNoGroup', 1);
        try {
            await selectCharacter(page, current);
            const result = await page.evaluate(async (missing) => {
                const { Generate, setOnlineStatus } = await import('/script.js');
                // Offline, Generate returns before any backend call; a group branch would run before that.
                setOnlineStatus('no_connection');
                try {
                    await Generate('normal', { force_chid: missing });
                    return null;
                } catch (e) {
                    return { name: e.name, message: e.message };
                }
            }, MISSING_INDEX);
            expect(result).toBeNull();
        } finally {
            await deleteCharacters(page, [current]);
        }
    });
});

test.describe('#11/#12 getCharacterCardFields and getCharacterCardFieldsLazy', () => {
    test.beforeEach(testSetup.awaitST);

    /**
     * The description each export returns for these options.
     * @param {import('@playwright/test').Page} page
     * @param {object} options
     * @returns {Promise<{fields: string, lazy: string}>}
     */
    async function descriptionsFor(page, options) {
        return page.evaluate(async (options) => {
            const { getCharacterCardFields, getCharacterCardFieldsLazy } = await import('/script.js');
            return {
                fields: getCharacterCardFields(options).description,
                lazy: getCharacterCardFieldsLazy(options).description,
            };
        }, options);
    }

    test('chid as an index string, a number or an avatar, and avatar, give the same character\'s fields', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxFields', 2);
        try {
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);
            const expected = (await fetchStoredCharacter(page, target)).body.description;
            expect(expected).toMatch(/^description 1 /);

            for (const options of [{ chid: index }, { chid: Number(index) }, { chid: target }, { avatar: target }, { chid: Number(index), avatar: target }]) {
                expect(await descriptionsFor(page, options)).toEqual({ fields: expected, lazy: expected });
            }
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('chid null or undefined means the current character', async ({ page }) => {
        const [current, other] = await createCharacters(page, 'IdxFieldsCurrent', 2);
        try {
            await selectCharacter(page, current);
            const expected = (await fetchStoredCharacter(page, current)).body.description;
            expect(expected).toMatch(/^description 0 /);

            for (const options of [{ chid: null }, { chid: undefined }, {}]) {
                expect(await descriptionsFor(page, options)).toEqual({ fields: expected, lazy: expected });
            }
            // With chid null, the avatar form applies.
            const otherDescription = (await fetchStoredCharacter(page, other)).body.description;
            expect(await descriptionsFor(page, { chid: null, avatar: other })).toEqual({ fields: otherDescription, lazy: otherDescription });
        } finally {
            await deleteCharacters(page, [current, other]);
        }
    });

    test('chid and avatar naming different characters give no character\'s fields, with one warning naming both', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxFieldsMismatch', 2);
        try {
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);

            const warnings = collectWarnings(page);
            for (const chid of [index, Number(index)]) {
                for (const lazy of [false, true]) {
                    const mark = warnings.length;
                    const fields = await page.evaluate(async ({ chid, avatar, lazy }) => {
                        const { getCharacterCardFields, getCharacterCardFieldsLazy } = await import('/script.js');
                        const all = (lazy ? getCharacterCardFieldsLazy : getCharacterCardFields)({ chid, avatar });
                        return { description: all.description, firstMessage: all.firstMessage, alternateGreetings: all.alternateGreetings };
                    }, { chid, avatar: current, lazy });
                    expect(fields).toEqual({ description: '', firstMessage: '', alternateGreetings: [] });
                    await expect.poll(() => warnings.slice(mark).filter(text => text.includes(PAIR_MISMATCH_WARNING)).length).toBe(1);
                    const mismatch = warnings.slice(mark).filter(text => text.includes(PAIR_MISMATCH_WARNING));
                    expect(mismatch[0]).toContain(String(chid));
                    expect(mismatch[0]).toContain(current);
                }
            }
            await page.waitForTimeout(500);
            expect(warnings.filter(text => text.includes(PAIR_MISMATCH_WARNING))).toHaveLength(4);
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });
});

test.describe('#13 renameGroupOrCharacterChat', () => {
    test.beforeEach(testSetup.awaitST);

    /**
     * Starts the rename. A failure awaits the user closing the "Chat was not renamed" popup, so the call is
     * left running and awaited by {@link finishRename}.
     * @param {import('@playwright/test').Page} page
     * @param {object} params
     */
    async function startRename(page, params) {
        await page.evaluate(async (params) => {
            const { renameGroupOrCharacterChat } = await import('/script.js');
            // @ts-ignore
            window.__rename = renameGroupOrCharacterChat(params);
        }, params);
    }

    /** @param {import('@playwright/test').Page} page */
    async function finishRename(page) {
        await page.evaluate(async () => {
            // @ts-ignore
            await window.__rename;
        });
    }

    /**
     * Expects the rename to fail with upstream's "Chat was not renamed" popup, and closes it.
     * @param {import('@playwright/test').Page} page
     */
    async function expectNotRenamed(page) {
        const popup = page.locator('dialog[open]').filter({ hasText: 'Chat was not renamed' });
        await expect(popup).toBeVisible({ timeout: 10000 });
        await popup.locator('.popup-button-ok').click();
        await finishRename(page);
    }

    test('characterId as an index string, a number or an avatar, and characterAvatar, rename the same character\'s chat', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxRename', 2);
        try {
            await saveChat(page, target, 'name-0');
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);
            const renames = recordPosts(page, '/api/chats/rename');

            const forms = [{ characterId: index }, { characterId: Number(index) }, { characterId: target }, { characterAvatar: target }];
            for (let i = 0; i < forms.length; i++) {
                const oldFileName = `name-${i}`;
                const newFileName = `name-${i + 1}`;
                await startRename(page, { ...forms[i], oldFileName, newFileName });
                await finishRename(page);
                expect(renames[i]).toMatchObject({ is_group: false, avatar_url: target, original_file: `${oldFileName}.jsonl`, renamed_file: `${newFileName}.jsonl` });
                const names = await listChatNames(page, target);
                expect(names).toContain(newFileName);
                expect(names).not.toContain(oldFileName);
            }
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('characterId null sends no avatar_url and the chat is not renamed', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxRenameNull', 2);
        try {
            await saveChat(page, target, 'kept');
            await selectCharacter(page, current);
            const renames = recordPosts(page, '/api/chats/rename');

            await startRename(page, { characterId: null, oldFileName: 'kept', newFileName: 'not-used' });
            await expectNotRenamed(page);

            expect(renames).toHaveLength(1);
            expect(Object.hasOwn(renames[0], 'avatar_url')).toBe(false);
            expect(await listChatNames(page, target)).toContain('kept');
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('characterId and characterAvatar naming different characters rename nothing, with one warning naming both', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxRenameMismatch', 2);
        try {
            await saveChat(page, target, 'kept');
            await saveChat(page, current, 'kept');
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);
            const renames = recordPosts(page, '/api/chats/rename');
            const warnings = collectWarnings(page);

            await startRename(page, { characterId: index, characterAvatar: current, oldFileName: 'kept', newFileName: 'not-used' });
            await expectNotRenamed(page);

            expect(renames).toHaveLength(1);
            expect(Object.hasOwn(renames[0], 'avatar_url')).toBe(false);
            expect(await listChatNames(page, target)).toContain('kept');
            expect(await listChatNames(page, current)).toContain('kept');
            const mismatch = warnings.filter(text => text.includes(PAIR_MISMATCH_WARNING));
            expect(mismatch).toHaveLength(1);
            expect(mismatch[0]).toContain(index);
            expect(mismatch[0]).toContain(current);
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });
});

test.describe('writeExtensionField index branch', () => {
    test.beforeEach(testSetup.awaitST);

    test('an index string, a number and an avatar write the same character\'s field; only the index forms warn', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxExtField', 2);
        try {
            const index = await indexOf(page, target);
            await selectCharacter(page, current);
            await expectIndexNames(page, index, target);
            const merges = recordPosts(page, '/api/characters/merge-attributes');

            const calls = [['idx_by_index_string', index, true], ['idx_by_number', Number(index), true], ['idx_by_avatar', target, false]];
            const warnings = collectWarnings(page);
            for (const [key, ref, warns] of calls) {
                const mark = warnings.length;
                merges.length = 0;
                await page.evaluate(async ({ ref, key }) => {
                    // @ts-ignore
                    await SillyTavern.getContext().writeExtensionField(ref, key, { written: key });
                }, { ref, key });
                expect(merges).toEqual([{ avatar: target, data: { extensions: { [key]: { written: key } } } }]);
                expect((await fetchStoredCharacter(page, target)).body.data.extensions[key]).toEqual({ written: key });
                await page.waitForTimeout(300);
                expect(warnings.slice(mark).filter(text => text.includes(LEGACY_INDEX_WARNING)).length).toBe(warns ? 1 : 0);
            }
            expect((await fetchStoredCharacter(page, current)).body.data.extensions.idx_by_avatar).toBeUndefined();
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('an index that names no character writes nothing', async ({ page }) => {
        const [current] = await createCharacters(page, 'IdxExtFieldMiss', 1);
        try {
            await selectCharacter(page, current);
            const merges = recordPosts(page, '/api/characters/merge-attributes');
            const warnings = collectWarnings(page);

            for (const ref of [String(MISSING_INDEX), MISSING_INDEX]) {
                await page.evaluate(async (ref) => {
                    // @ts-ignore
                    await SillyTavern.getContext().writeExtensionField(ref, 'idx_miss', { written: true });
                }, ref);
            }
            await page.waitForTimeout(1000);

            expect(merges).toEqual([]);
            expect(warnings.filter(text => text.includes('Character not found')).length).toBe(2);
            expect((await fetchStoredCharacter(page, current)).body.data.extensions.idx_miss).toBeUndefined();
        } finally {
            await deleteCharacters(page, [current]);
        }
    });
});
