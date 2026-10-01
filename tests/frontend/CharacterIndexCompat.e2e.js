import zlib from 'node:zlib';
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
        // @ts-ignore
        for (const id of window.__idxGroups ?? []) {
            await fetch('/api/groups/delete', { method: 'POST', headers, body: JSON.stringify({ id }) });
        }
        // @ts-ignore
        window.__idxGroups = [];
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
 * Opens a new group of these characters. Extensions are shown only the current character or the open group's
 * members, so this is how a test gets an index into `getContext().characters` naming a character that isn't the
 * current one. {@link deleteCharacters} deletes the group too.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} avatars
 * @returns {Promise<{groupId: string, indices: Record<string, string>}>} The group, and each avatar's index string.
 */
async function openGroupOf(page, avatars) {
    const groupId = await page.evaluate(async ({ members, name }) => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        const response = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name, members }) });
        if (!response.ok) throw new Error(`group create failed: ${response.status}`);
        const id = String((await response.json()).id);
        const { groupsStore, openGroupById } = await import('/scripts/group-chats.js');
        await ctx.getCharacters({ silentGroups: true });
        groupsStore.reportCreated(id);
        await openGroupById(id);
        // @ts-ignore
        (window.__idxGroups ??= []).push(id);
        return id;
    }, { members: avatars, name: `IdxGroup-${stamp()}` });
    await expect.poll(() => page.evaluate(() => {
        // @ts-ignore
        return SillyTavern.getContext().groupId;
    })).toBe(groupId);
    const indices = await page.evaluate((avatars) => Object.fromEntries(avatars.map(avatar => {
        // @ts-ignore
        return [avatar, String(SillyTavern.getContext().characters.findIndex(character => character.avatar === avatar))];
    })), avatars);
    for (const avatar of avatars) {
        expect(indices[avatar]).toMatch(/^(0|[1-9]\d*)$/);
    }
    return { groupId, indices };
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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
            // Selecting puts the editor in front of the character list; bring the list back as a user would.
            await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'editcharacter');
            await expect(page.locator('#right-nav-panel')).toBeHidden();
            await page.locator('#rightNavDrawerIcon').click();
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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
        const [firstIndex, secondIndex] = await page.evaluate((avatars) => avatars.map(avatar => {
            // @ts-ignore
            return String(SillyTavern.getContext().characters.findIndex(character => character.avatar === avatar));
        }), [first, second]);
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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
            const index = (await openGroupOf(page, [current, target])).indices[target];
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

test.describe('emitted indices: GENERATION_STARTED and GENERATION_AFTER_COMMANDS force_chid (step 11)', () => {
    test.beforeEach(testSetup.awaitST);

    // Upstream's options payload, in upstream's key order.
    const UPSTREAM_OPTION_KEYS = ['automatic_trigger', 'force_name2', 'quiet_prompt', 'quietToLoud', 'skipWIAN', 'force_chid', 'force_avatar', 'signal', 'quietImage'];

    /**
     * Calls Generate offline (it returns before any backend call) and reports both events' payloads.
     * @param {import('@playwright/test').Page} page
     * @param {{omitOptions?: boolean, options?: object}} call
     */
    async function generationPayloads(page, { omitOptions = false, options = {} }) {
        return page.evaluate(async ({ omitOptions, options }) => {
            const { Generate, setOnlineStatus } = await import('/script.js');
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            const payloads = [];
            const record = (event) => (type, opts, dryRun) => payloads.push({
                event,
                type,
                keys: Object.keys(opts),
                hasForceChid: Object.hasOwn(opts, 'force_chid'),
                forceChidType: typeof opts.force_chid,
                forceChid: opts.force_chid,
                forceAvatar: opts.force_avatar,
                dryRun,
            });
            const onStarted = record('GENERATION_STARTED');
            const onAfterCommands = record('GENERATION_AFTER_COMMANDS');
            ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, onStarted);
            ctx.eventSource.on(ctx.eventTypes.GENERATION_AFTER_COMMANDS, onAfterCommands);
            setOnlineStatus('no_connection');
            try {
                await (omitOptions ? Generate('normal') : Generate('normal', options));
            } finally {
                ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_STARTED, onStarted);
                ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_AFTER_COMMANDS, onAfterCommands);
            }
            return payloads;
        }, { omitOptions, options });
    }

    /**
     * Both events' payloads, as expected for this force_chid and force_avatar.
     * @param {any} forceChid
     * @param {string|undefined} forceAvatar
     */
    function expectedPayloads(forceChid, forceAvatar) {
        return ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS'].map(event => ({
            event,
            type: 'normal',
            keys: UPSTREAM_OPTION_KEYS,
            hasForceChid: true,
            forceChidType: typeof forceChid,
            forceChid,
            forceAvatar,
            dryRun: false,
        }));
    }

    test('force_chid is carried as passed: a number, an index string, an avatar string, null, not passed, options omitted', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxGenEvents', 2);
        try {
            const index = (await openGroupOf(page, [current, target])).indices[target];
            await expectIndexNames(page, index, target);

            const cases = [
                [{ options: { force_chid: Number(index) } }, Number(index), undefined],
                [{ options: { force_chid: index } }, index, undefined],
                [{ options: { force_chid: target } }, target, undefined],
                [{ options: { force_chid: null } }, null, undefined],
                [{ options: {} }, undefined, undefined],
                [{ omitOptions: true }, undefined, undefined],
            ];
            for (const [call, forceChid, forceAvatar] of cases) {
                expect(await generationPayloads(page, call)).toEqual(expectedPayloads(forceChid, forceAvatar));
            }
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('force_avatar is carried next to force_chid, with and without it', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxGenEventsAvatar', 2);
        try {
            const index = (await openGroupOf(page, [current, target])).indices[target];
            await expectIndexNames(page, index, target);

            expect(await generationPayloads(page, { options: { force_chid: Number(index), force_avatar: target } })).toEqual(expectedPayloads(Number(index), target));
            expect(await generationPayloads(page, { options: { force_chid: index, force_avatar: target } })).toEqual(expectedPayloads(index, target));
            expect(await generationPayloads(page, { options: { force_avatar: target } })).toEqual(expectedPayloads(undefined, target));
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });
});

test.describe('emitted indices: CHARACTER_EDITOR_OPENED (step 12)', () => {
    test.beforeEach(testSetup.awaitST);

    /**
     * Records every CHARACTER_EDITOR_OPENED from here on into `window.__editorOpened`.
     * @param {import('@playwright/test').Page} page
     */
    async function recordEditorOpened(page) {
        await page.evaluate(() => {
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            // @ts-ignore
            window.__editorOpened = [];
            ctx.eventSource.on(ctx.eventTypes.CHARACTER_EDITOR_OPENED, (...args) => {
                // @ts-ignore
                window.__editorOpened.push({ count: args.length, type: typeof args[0], chid: args[0] });
            });
        });
    }

    /**
     * Returns the CHARACTER_EDITOR_OPENED emits recorded so far, and clears them.
     * @param {import('@playwright/test').Page} page
     * @returns {Promise<{count: number, type: string, chid: any}[]>}
     */
    async function takeEditorOpened(page) {
        return page.evaluate(() => {
            // @ts-ignore
            return window.__editorOpened.splice(0);
        });
    }

    /** @param {import('@playwright/test').Page} page */
    async function currentCharacterId(page) {
        return page.evaluate(() => {
            // @ts-ignore
            return SillyTavern.getContext().characterId;
        });
    }

    /**
     * @param {any} chid
     * @returns {{count: number, type: string, chid: any}}
     */
    function emitted(chid) {
        return { count: 1, type: typeof chid, chid };
    }

    test('an index is emitted as passed; an avatar emits this_chid for the current character and undefined otherwise', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxEditorEvent', 2);
        try {
            const index = (await openGroupOf(page, [current, target])).indices[target];
            await expectIndexNames(page, index, target);
            // A member opened in the editor is the current character while the group stays open.
            await page.evaluate(async (avatar) => {
                const { setCharacterId } = await import('/scripts/character-store.js');
                setCharacterId(avatar);
            }, current);
            const currentIndex = await currentCharacterId(page);
            await expectIndexNames(page, currentIndex, current);
            await recordEditorOpened(page);

            const cases = [[index, index], [Number(index), Number(index)], [current, currentIndex], [target, undefined]];
            for (const [ref, expected] of cases) {
                await page.evaluate(async (ref) => {
                    const { select_selected_character } = await import('/script.js');
                    select_selected_character(ref);
                }, ref);
                expect(await takeEditorOpened(page)).toEqual([emitted(expected)]);
            }
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('first-party UI paths emit the selected character\'s this_chid', async ({ page }) => {
        const [current, target] = await createCharacters(page, 'IdxEditorEventUi', 2);
        try {
            await selectCharacter(page, current);
            await recordEditorOpened(page);

            // Selecting a character (what a click on its list row runs).
            await selectCharacter(page, target);
            const targetIndex = await currentCharacterId(page);
            await expectIndexNames(page, targetIndex, target);
            const onSelect = await takeEditorOpened(page);
            expect(onSelect.length).toBeGreaterThan(0);
            expect(onSelect).toEqual(onSelect.map(() => emitted(targetIndex)));

            // The navbar's selected-character button.
            await page.locator('#rm_button_selected_ch').click();
            await expect.poll(() => page.evaluate(() => {
                // @ts-ignore
                return window.__editorOpened.length;
            })).toBe(1);
            expect(await takeEditorOpened(page)).toEqual([emitted(targetIndex)]);
        } finally {
            await deleteCharacters(page, [current, target]);
        }
    });

    test('the group-member peek emits the peeked member\'s this_chid', async ({ page }) => {
        const [first, second] = await createCharacters(page, 'IdxEditorEventPeek', 2);
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
        }, { members: [first, second], name: `IdxEditorEventPeek-${stamp()}` });
        try {
            await page.evaluate(async (groupId) => {
                const { openGroupById } = await import('/scripts/group-chats.js');
                await openGroupById(groupId);
            }, groupId);
            await expect.poll(() => page.evaluate(() => {
                // @ts-ignore
                return SillyTavern.getContext().groupId;
            })).toBe(groupId);
            const secondIndex = await page.evaluate((avatar) => {
                // @ts-ignore
                return String(SillyTavern.getContext().characters.findIndex(character => character.avatar === avatar));
            }, second);
            await expectIndexNames(page, secondIndex, second);
            await recordEditorOpened(page);

            await page.locator('#rm_button_selected_ch').click();
            const view = page.locator(`.rm_group_members .group_member[data-avatar="${second}"] [data-action="view"]`);
            await expect(view).toHaveCount(1, { timeout: 10000 });
            // Drops the emits from opening the group panel.
            await takeEditorOpened(page);
            await view.click();
            await expect(page.locator('#avatar_url_pole')).toHaveValue(second, { timeout: 10000 });
            expect(await takeEditorOpened(page)).toEqual([emitted(secondIndex)]);
            expect(await currentCharacterId(page)).toBe(secondIndex);
        } finally {
            await page.evaluate(async (id) => {
                // @ts-ignore
                const headers = SillyTavern.getContext().getRequestHeaders();
                await fetch('/api/groups/delete', { method: 'POST', headers, body: JSON.stringify({ id }) });
            }, groupId);
            await deleteCharacters(page, [first, second]);
        }
    });
});

test.describe('emitted indices: CHARACTER_DELETED id (step 13)', () => {
    test.beforeEach(testSetup.awaitST);

    /**
     * Records every CHARACTER_DELETED from here on into `window.__deleted`.
     * @param {import('@playwright/test').Page} page
     */
    async function recordDeleted(page) {
        await page.evaluate(() => {
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            // @ts-ignore
            window.__deleted = [];
            ctx.eventSource.on(ctx.eventTypes.CHARACTER_DELETED, (payload) => {
                // @ts-ignore
                window.__deleted.push({
                    keys: Object.keys(payload),
                    idType: typeof payload.id,
                    id: payload.id,
                    idIsNegativeZero: Object.is(payload.id, -0),
                    avatar: payload.character?.avatar,
                });
            });
        });
    }

    /**
     * Returns the CHARACTER_DELETED payloads recorded so far, and clears them.
     * @param {import('@playwright/test').Page} page
     */
    async function takeDeleted(page) {
        return page.evaluate(() => {
            // @ts-ignore
            return window.__deleted.splice(0);
        });
    }

    /**
     * @param {number|undefined} id
     * @param {string} avatar
     */
    function deletedPayload(id, avatar) {
        return { keys: ['id', 'character'], idType: typeof id, id, idIsNegativeZero: false, avatar };
    }

    test('handleDeleteCharacter with an index string, a number or [n] emits the index as a number', async ({ page }) => {
        const [bystander, byIndexString, byNumber, byArray] = await createCharacters(page, 'IdxDeletedEvent', 4);
        try {
            await recordDeleted(page);

            // Each deletion can shift later indices, so each index is read just before its call.
            const refs = [[byIndexString, (index) => index], [byNumber, (index) => Number(index)], [byArray, (index) => [Number(index)]]];
            for (const [avatar, toRef] of refs) {
                // A delete closes the group, so each call gets a group of its own.
                await openGroupOf(page, [bystander, avatar]);
                const index = await page.evaluate((avatar) => {
                    // @ts-ignore
                    return String(SillyTavern.getContext().characters.findIndex(character => character.avatar === avatar));
                }, avatar);
                await expectIndexNames(page, index, avatar);
                await deleteVia(page, toRef(index));
                expect((await fetchStoredCharacter(page, avatar)).ok).toBe(false);
                expect(await takeDeleted(page)).toEqual([deletedPayload(Number(index), avatar)]);
            }
        } finally {
            await deleteCharacters(page, [bystander, byIndexString, byNumber, byArray]);
        }
    });

    test('an avatar-called delete emits id undefined, as an own key', async ({ page }) => {
        const [bystander, byHandleAvatar, byDeleteCharacter, byDeleteButton] = await createCharacters(page, 'IdxDeletedEventAvatar', 4);
        try {
            await selectCharacter(page, bystander);
            await recordDeleted(page);

            // handleDeleteCharacter with the avatar form.
            await deleteVia(page, byHandleAvatar);
            expect((await fetchStoredCharacter(page, byHandleAvatar)).ok).toBe(false);
            expect(await takeDeleted(page)).toEqual([deletedPayload(undefined, byHandleAvatar)]);

            // An extension calling deleteCharacter(avatar). A delete closes the current chat, and with nothing
            // selected deleteCharacter first asks to close the temporary chat.
            await selectCharacter(page, bystander);
            await page.evaluate(async (avatar) => {
                const { deleteCharacter } = await import('/script.js');
                await deleteCharacter(avatar, { deleteChats: true });
            }, byDeleteCharacter);
            expect((await fetchStoredCharacter(page, byDeleteCharacter)).ok).toBe(false);
            expect(await takeDeleted(page)).toEqual([deletedPayload(undefined, byDeleteCharacter)]);

            // The editor's delete button, which deletes the current character by avatar.
            await selectCharacter(page, byDeleteButton);
            await page.locator('#delete_button').click();
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect.poll(async () => (await fetchStoredCharacter(page, byDeleteButton)).ok, { timeout: 10000 }).toBe(false);
            await expect.poll(() => page.evaluate(() => {
                // @ts-ignore
                return window.__deleted.length;
            })).toBe(1);
            expect(await takeDeleted(page)).toEqual([deletedPayload(undefined, byDeleteButton)]);

            expect((await fetchStoredCharacter(page, bystander)).ok).toBe(true);
        } finally {
            await deleteCharacters(page, [bystander, byHandleAvatar, byDeleteCharacter, byDeleteButton]);
        }
    });
});

test.describe('#9 saveSettings and saveSettingsDebounced', () => {
    // saveSettings' retry messages, and TempResponseLength.restore's log.
    const RESPONSE_LENGTH_WARNING = 'Response length is currently being overridden, scheduling another save';
    const RESPONSE_LENGTH_ERROR = 'Response length is currently being overridden, but the save loop has reached the maximum number of retries';
    const RESTORE_LOG = '[TempResponseLength] Restored original response length:';
    // Longer than the save debounce (DEFAULT_SAVE_EDIT_TIMEOUT, 1000 ms), so a window started before it has run.
    const PAST_WINDOW = 2500;
    // Three rescheduled windows plus the final save.
    const RETRY_TIMEOUT = 15000;

    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        // Lets any save the boot scheduled run before a test starts recording.
        await page.waitForTimeout(PAST_WINDOW);
    });

    test.afterEach(async ({ page }) => {
        await releaseResponseLength(page);
    });

    /**
     * From here on, in order: upstream's retry warning and error, the restore log, and each POST to
     * /api/settings/save ('save') or /api/settings/save-partial ('save-partial') with its JSON body.
     * @param {import('@playwright/test').Page} page
     * @returns {{kind: string, text?: string, body?: any}[]}
     */
    function recordSettingsSaves(page) {
        const timeline = [];
        page.on('console', (message) => {
            const text = message.text();
            if (text === RESPONSE_LENGTH_WARNING || text === RESPONSE_LENGTH_ERROR || text.startsWith(RESTORE_LOG)) {
                timeline.push({ kind: message.type(), text });
            }
        });
        page.on('request', (request) => {
            if (request.method() !== 'POST') return;
            const path = new URL(request.url()).pathname;
            if (path !== '/api/settings/save' && path !== '/api/settings/save-partial') return;
            let raw = request.postDataBuffer() ?? Buffer.alloc(0);
            if (request.headers()['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
            let body;
            try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
            timeline.push({ kind: path === '/api/settings/save' ? 'save' : 'save-partial', body });
        });
        return timeline;
    }

    /**
     * The timeline, with each full save reduced to the given probes' values and amount_gen, and each partial
     * save to its keys and whether it carries expectedHashes.
     * @param {{kind: string, text?: string, body?: any}[]} timeline
     * @param {{name: string}[]} probes
     */
    function project(timeline, probes) {
        return timeline.map((event) => {
            if (event.kind === 'save') {
                return { kind: 'save', probes: probes.map(probe => event.body?.power_user?.[probe.name]), amountGen: event.body?.amount_gen };
            }
            if (event.kind === 'save-partial') {
                return { kind: 'save-partial', keys: event.body?.keys, hasExpectedHashes: typeof event.body?.expectedHashes === 'object' };
            }
            return event;
        });
    }

    /**
     * Waits for the timeline to reach the length, then past one more debounce window so a later event would show.
     * @param {import('@playwright/test').Page} page
     * @param {any[]} timeline
     * @param {number} length
     */
    async function settle(page, timeline, length) {
        await expect.poll(() => timeline.length, { timeout: RETRY_TIMEOUT }).toBeGreaterThanOrEqual(length);
        await page.waitForTimeout(PAST_WINDOW);
    }

    /**
     * Names a fresh power_user field, so each save of it differs from the last saved settings.
     * @returns {{name: string, key: string, value: string}}
     */
    function newProbe() {
        const name = `idx_save_probe_${stamp().replace('-', '_')}`;
        return { name, key: `power_user.${name}`, value: `value-${stamp()}` };
    }

    /**
     * Runs the steps in one evaluate, with no await between them other than a direct saveSettings() call's own.
     * A step either sets a probe's value in power_user, or calls a script.js export with arguments.
     * @param {import('@playwright/test').Page} page
     * @param {({probe: {name: string, value: string}} | {call: string, args: any[]})[]} steps
     */
    async function runSteps(page, steps) {
        await page.evaluate(async (steps) => {
            const script = await import('/script.js');
            // @ts-ignore
            const powerUser = SillyTavern.getContext().powerUserSettings;
            for (const step of steps) {
                if ('probe' in step) {
                    powerUser[step.probe.name] = step.probe.value;
                    continue;
                }
                const result = script[step.call](...step.args);
                if (result instanceof Promise) await result;
            }
        }, steps);
    }

    /**
     * Makes TempResponseLength customized, as an in-flight generateRawData({ responseLength }) does: the generation
     * is held in a GENERATE_AFTER_COMBINE_PROMPTS listener until releaseResponseLength().
     * @param {import('@playwright/test').Page} page
     * @returns {Promise<{original: number, overridden: number}>} amount_gen before and during the override.
     */
    async function holdResponseLength(page) {
        return page.evaluate(async () => {
            const { generateRawData } = await import('/script.js');
            const params = await import('/scripts/generation-params.js');
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            const original = params.amount_gen;
            const responseLength = original + 1;
            let entered;
            const inside = new Promise(resolve => entered = resolve);
            let release;
            const released = new Promise(resolve => release = resolve);
            const listener = async () => {
                entered();
                await released;
            };
            ctx.eventSource.on(ctx.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, listener);
            // Stopped before it is released, so it never reaches a backend.
            const generation = generateRawData({ prompt: 'hold', api: 'kobold', responseLength }).catch(() => { });
            await inside;
            ctx.eventSource.removeListener(ctx.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, listener);
            // @ts-ignore
            window.__responseLengthHold = async () => {
                await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STOPPED);
                release();
                await generation;
            };
            return { original, overridden: params.amount_gen };
        });
    }

    /**
     * Ends a holdResponseLength() generation, if one is held.
     * @param {import('@playwright/test').Page} page
     */
    async function releaseResponseLength(page) {
        await page.evaluate(async () => {
            // @ts-ignore
            const hold = window.__responseLengthHold;
            // @ts-ignore
            window.__responseLengthHold = null;
            if (hold) await hold();
        });
    }

    /**
     * The retry messages for a save that starts at count 0: three reschedules, then the error and the restore.
     * @param {number} original amount_gen before the override.
     */
    function retriesFromZero(original) {
        return [
            { kind: 'warning', text: RESPONSE_LENGTH_WARNING },
            { kind: 'warning', text: RESPONSE_LENGTH_WARNING },
            { kind: 'warning', text: RESPONSE_LENGTH_WARNING },
            { kind: 'error', text: RESPONSE_LENGTH_ERROR },
            { kind: 'log', text: `${RESTORE_LOG} ${original}` },
        ];
    }

    test('saveSettings(1) does a full save and does not cancel a pending debounced save', async ({ page }) => {
        const timeline = recordSettingsSaves(page);
        const a = newProbe();
        const b = newProbe();
        await runSteps(page, [
            { probe: a },
            { call: 'saveSettingsDebounced', args: [] },
            { call: 'saveSettings', args: [1] },
            { probe: b },
        ]);
        await settle(page, timeline, 2);
        expect(project(timeline, [a, b])).toEqual([
            { kind: 'save', probes: [a.value, undefined], amountGen: expect.any(Number) },
            { kind: 'save', probes: [a.value, b.value], amountGen: expect.any(Number) },
        ]);
    });

    test('saveSettings(\'key\') is a partial save as today', async ({ page }) => {
        const timeline = recordSettingsSaves(page);
        const a = newProbe();
        await runSteps(page, [
            { probe: a },
            { call: 'saveSettings', args: [a.key] },
        ]);
        await settle(page, timeline, 1);
        expect(project(timeline, [a])).toEqual([
            { kind: 'save-partial', keys: { [a.key]: a.value }, hasExpectedHashes: true },
        ]);
    });

    test('with TempResponseLength customized, saveSettings(0) reschedules through counters 1, 2 and 3, then restores and saves, with upstream\'s messages', async ({ page }) => {
        const { original, overridden } = await holdResponseLength(page);
        expect(overridden).not.toBe(original);
        const timeline = recordSettingsSaves(page);
        const a = newProbe();
        await runSteps(page, [
            { probe: a },
            { call: 'saveSettings', args: [0] },
        ]);
        await settle(page, timeline, 6);
        expect(project(timeline, [a])).toEqual([
            ...retriesFromZero(original),
            { kind: 'save', probes: [a.value], amountGen: original },
        ]);
    });

    test('saveSettingsDebounced(2) followed by saveSettingsDebounced() in one window runs with count 0', async ({ page }) => {
        // Count 2 alone: one reschedule (to 3), then the error, the restore and the save.
        let { original } = await holdResponseLength(page);
        const timeline = recordSettingsSaves(page);
        const a = newProbe();
        await runSteps(page, [
            { probe: a },
            { call: 'saveSettingsDebounced', args: [2] },
        ]);
        await settle(page, timeline, 4);
        expect(project(timeline, [a])).toEqual([
            { kind: 'warning', text: RESPONSE_LENGTH_WARNING },
            { kind: 'error', text: RESPONSE_LENGTH_ERROR },
            { kind: 'log', text: `${RESTORE_LOG} ${original}` },
            { kind: 'save', probes: [a.value], amountGen: original },
        ]);
        await releaseResponseLength(page);

        // Count 2, then no count, in one window: the run has count 0, so three reschedules.
        ({ original } = await holdResponseLength(page));
        const b = newProbe();
        await runSteps(page, [
            { probe: b },
            { call: 'saveSettingsDebounced', args: [2] },
            { call: 'saveSettingsDebounced', args: [] },
        ]);
        await settle(page, timeline, 4 + 6);
        expect(project(timeline.slice(4), [b])).toEqual([
            ...retriesFromZero(original),
            { kind: 'save', probes: [b.value], amountGen: original },
        ]);
    });

    test('saveSettings() with keys pending sends one full save that includes them, and leaves pendingSettingsKeys empty', async ({ page }) => {
        const timeline = recordSettingsSaves(page);
        const a = newProbe();
        await runSteps(page, [
            { probe: a },
            { call: 'saveSettingsDebounced', args: [a.key] },
            { call: 'saveSettings', args: [] },
        ]);
        // The keyed window still runs, and finds nothing pending.
        await settle(page, timeline, 1);
        expect(project(timeline, [a])).toEqual([
            { kind: 'save', probes: [a.value], amountGen: expect.any(Number) },
        ]);

        // A keyed save sends its keys plus any still pending, so a keyed save of b shows a is no longer pending.
        const b = newProbe();
        await runSteps(page, [
            { probe: b },
            { call: 'saveSettings', args: [b.key] },
        ]);
        await settle(page, timeline, 2);
        expect(project(timeline, [a, b])).toEqual([
            { kind: 'save', probes: [a.value, undefined], amountGen: expect.any(Number) },
            { kind: 'save-partial', keys: { [b.key]: b.value }, hasExpectedHashes: true },
        ]);
    });

    test('saveSettingsDebounced(\'key\') alone reaches the server as a keyed partial save to /save-partial', async ({ page }) => {
        const timeline = recordSettingsSaves(page);
        const a = newProbe();
        await runSteps(page, [
            { probe: a },
            { call: 'saveSettingsDebounced', args: [a.key] },
        ]);
        await settle(page, timeline, 1);
        expect(project(timeline, [a])).toEqual([
            { kind: 'save-partial', keys: { [a.key]: a.value }, hasExpectedHashes: true },
        ]);
    });

    test('saveSettingsDebounced(\'key\') plus saveSettingsDebounced() in one window sends one full save that includes key', async ({ page }) => {
        const timeline = recordSettingsSaves(page);
        const a = newProbe();
        await runSteps(page, [
            { probe: a },
            { call: 'saveSettingsDebounced', args: [a.key] },
            { call: 'saveSettingsDebounced', args: [] },
        ]);
        await settle(page, timeline, 1);
        expect(project(timeline, [a])).toEqual([
            { kind: 'save', probes: [a.value], amountGen: expect.any(Number) },
        ]);
    });

    test('with TempResponseLength customized, saveSettings(\'key\') reschedules through counts 1, 2 and 3 as keyed saves, then restores and sends a keyed partial save of key; no full save is sent', async ({ page }) => {
        const { original } = await holdResponseLength(page);
        const timeline = recordSettingsSaves(page);
        const a = newProbe();
        await runSteps(page, [
            { probe: a },
            { call: 'saveSettings', args: [a.key] },
        ]);
        await settle(page, timeline, 6);
        expect(project(timeline, [a])).toEqual([
            ...retriesFromZero(original),
            { kind: 'save-partial', keys: { [a.key]: a.value }, hasExpectedHashes: true },
        ]);
    });

    test('a direct saveSettings(\'key\') doesn\'t cancel a pending window that asked for a full save', async ({ page }) => {
        const timeline = recordSettingsSaves(page);
        const a = newProbe();
        const b = newProbe();
        await runSteps(page, [
            { probe: a },
            { call: 'saveSettingsDebounced', args: [] },
            { probe: b },
            { call: 'saveSettings', args: [b.key] },
        ]);
        await settle(page, timeline, 2);
        expect(project(timeline, [a, b])).toEqual([
            { kind: 'save-partial', keys: { [b.key]: b.value }, hasExpectedHashes: true },
            { kind: 'save', probes: [a.value, b.value], amountGen: expect.any(Number) },
        ]);
    });

    test('after a full save of key=A, a keyed save of key=B and then a keyed save of key back to A both reach the server, and the server holds A', async ({ page }) => {
        const timeline = recordSettingsSaves(page);
        const a = newProbe();
        const b = { ...a, value: `${a.value}-b` };

        await runSteps(page, [
            { probe: a },
            { call: 'saveSettings', args: [] },
        ]);
        await settle(page, timeline, 1);

        await runSteps(page, [
            { probe: b },
            { call: 'saveSettings', args: [b.key] },
        ]);
        await settle(page, timeline, 2);

        await runSteps(page, [
            { probe: a },
            { call: 'saveSettings', args: [a.key] },
        ]);
        await settle(page, timeline, 3);

        expect(project(timeline, [a])).toEqual([
            { kind: 'save', probes: [a.value], amountGen: expect.any(Number) },
            { kind: 'save-partial', keys: { [a.key]: b.value }, hasExpectedHashes: true },
            { kind: 'save-partial', keys: { [a.key]: a.value }, hasExpectedHashes: true },
        ]);

        const onServer = await page.evaluate(async (name) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            const response = await fetch('/api/settings/get', { method: 'POST', headers, body: JSON.stringify({}), cache: 'no-cache' });
            const data = await response.json();
            return JSON.parse(data.settings).power_user?.[name];
        }, a.name);
        expect(onServer).toBe(a.value);
    });

});

test.describe('getEntitiesList (step 10)', () => {
    test.beforeEach(testSetup.awaitST);

    // Smaller than the entities setUpList() leaves in the list, so the list has more than one page.
    const PAGE_SIZE = 10;
    const LIST_CHARACTERS = 12;
    // Not one of the server's /query sort fields, so printCharacters() falls back to name order. No entity's item has
    // it either, so getEntitiesList()'s browser sort by it leaves the page's order as it is.
    const REJECTED_SORT_FIELD = 'no_such_sort_field';
    // getEntitiesList()'s argument forms; null stands for no argument.
    const FLAG_COMBINATIONS = [null, {}, { doSort: false }, { doFilter: true }, { doFilter: true, doSort: false }, { doFilter: false, doSort: true }];

    /**
     * Defines, in the page: window.__listRows(), the character list's rows on screen in order, as `type:id` keys
     * (characters by data-avatar, groups by data-grid, folders by tagid); window.__listFavRows(), the same for the
     * rows marked as favourites; and window.__entityKeys(entities), the same keys for entities.
     * @param {import('@playwright/test').Page} page
     */
    async function installListProbe(page) {
        await page.evaluate(() => {
            const rowKey = (/** @type {Element} */ row) => {
                if (row.hasAttribute('data-avatar')) return `character:${row.getAttribute('data-avatar')}`;
                if (row.hasAttribute('data-grid')) return `group:${row.getAttribute('data-grid')}`;
                if (row.hasAttribute('tagid')) return `tag:${row.getAttribute('tagid')}`;
                return null;
            };
            const rows = () => [...document.getElementById('rm_print_characters_block').children].filter(row => rowKey(row) !== null);
            // @ts-ignore
            window.__listRows = () => rows().map(rowKey);
            // @ts-ignore
            window.__listFavRows = () => rows().filter(row => row.classList.contains('is_fav')).map(rowKey);
            // @ts-ignore
            window.__entityKeys = (entities) => entities.map(entity => `${entity.type}:${entity.id}`);
        });
    }

    /**
     * Creates LIST_CHARACTERS characters, every other one a favourite, then renders the list from page 1 at
     * PAGE_SIZE rows a page, with the saved sort or with one the server rejects.
     * @param {import('@playwright/test').Page} page
     * @param {{rejectedSort?: boolean}} [options]
     * @returns {Promise<{avatars: string[], favs: string[], originalSortField: string}>}
     */
    async function setUpList(page, { rejectedSort = false } = {}) {
        const s = stamp();
        const avatars = [];
        for (let i = 0; i < LIST_CHARACTERS; i++) {
            avatars.push(await createCharacter(page, `IdxEntities${String(i).padStart(2, '0')}-${s}`, `description ${i} ${s}`));
        }
        const favs = avatars.filter((_, i) => i % 2 === 0);
        await page.evaluate(async (favs) => {
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            const { getOneCharacter } = await import('/script.js');
            for (const avatar of favs) {
                const response = await fetch('/api/characters/fav', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar, fav: true }) });
                if (!response.ok) throw new Error(`fav failed: ${response.status}`);
                await getOneCharacter(avatar);
            }
            await ctx.getCharacters();
        }, favs);

        const queryStatuses = [];
        page.on('response', (response) => {
            if (new URL(response.url()).pathname === '/api/characters/query') queryStatuses.push(response.status());
        });
        await openCharacterManagementDrawer(page);
        await installListProbe(page);
        const originalSortField = await page.evaluate(async ({ pageSize, sortField }) => {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            const { power_user } = await import('/scripts/power-user.js');
            const { printCharacters } = await import('/script.js');
            const original = power_user.sort_field;
            accountStorage.setItem('Characters_PerPage', String(pageSize));
            if (sortField) power_user.sort_field = sortField;
            await printCharacters(true);
            return original;
        }, { pageSize: PAGE_SIZE, sortField: rejectedSort ? REJECTED_SORT_FIELD : null });
        // @ts-ignore
        await expect.poll(() => page.evaluate(() => window.__listRows().length)).toBe(PAGE_SIZE);

        // The render took the intended path: the server rejects the sort field, and serves the others.
        if (rejectedSort) {
            expect(queryStatuses).toContain(400);
        } else {
            expect(queryStatuses.length).toBeGreaterThan(0);
            expect(queryStatuses.every(status => status === 200)).toBe(true);
        }
        const favsLoaded = await page.evaluate(async (favs) => {
            const { normalizeFav } = await import('/scripts/hash-utils.js');
            // @ts-ignore
            return favs.every(avatar => normalizeFav(SillyTavern.getContext().getCharacterByAvatar(avatar)?.fav));
        }, favs);
        expect(favsLoaded).toBe(true);
        return { avatars, favs, originalSortField };
    }

    /**
     * Restores the sort field setUpList() may have changed, and deletes its characters. The page size lives in
     * this test's browser context only.
     * @param {import('@playwright/test').Page} page
     * @param {{avatars: string[], originalSortField: string}} list
     */
    async function tearDownList(page, { avatars, originalSortField }) {
        await page.evaluate(async (originalSortField) => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.sort_field = originalSortField;
        }, originalSortField);
        await deleteCharacters(page, avatars);
    }

    /**
     * In one synchronous run: the rows on screen, and getEntitiesList()'s keys for each of FLAG_COMBINATIONS.
     * @param {import('@playwright/test').Page} page
     * @returns {Promise<{rows: string[], results: string[][]}>}
     */
    async function snapshotList(page) {
        return page.evaluate(async (combinations) => {
            const { getEntitiesList } = await import('/script.js');
            // No await from here on, so the rows and the calls see the same render.
            // @ts-ignore
            const rows = window.__listRows();
            // @ts-ignore
            const results = combinations.map(options => window.__entityKeys(options === null ? getEntitiesList() : getEntitiesList(options)));
            return { rows, results };
        }, FLAG_COMBINATIONS);
    }

    /**
     * Turns the character list to its next page and waits for it to render.
     * @param {import('@playwright/test').Page} page
     */
    async function turnPage(page) {
        // @ts-ignore
        const firstRow = await page.evaluate(() => window.__listRows()[0]);
        await page.evaluate(() => {
            // @ts-ignore
            $('#rm_print_characters_pagination').pagination('next');
        });
        // @ts-ignore
        await expect.poll(() => page.evaluate(() => window.__listRows()[0])).not.toBe(firstRow);
    }

    test('getEntitiesList() returns an Array, not a Promise, with and without options', async ({ page }) => {
        const results = await page.evaluate(async (combinations) => {
            const { getEntitiesList } = await import('/script.js');
            return combinations.map((options) => {
                const result = options === null ? getEntitiesList() : getEntitiesList(options);
                return { isArray: Array.isArray(result), isPromise: result instanceof Promise, hasThen: typeof result?.['then'] === 'function' };
            });
        }, FLAG_COMBINATIONS);
        expect(results).toEqual(FLAG_COMBINATIONS.map(() => ({ isArray: true, isPromise: false, hasThen: false })));
    });

    for (const rejectedSort of [false, true]) {
        test(`after a render ${rejectedSort ? 'with a sort the server rejects' : 'with the saved sort'}, getEntitiesList() is the page on screen, in order, for every option, and follows a page turn`, async ({ page }) => {
            const list = await setUpList(page, { rejectedSort });
            try {
                const first = await snapshotList(page);
                expect(first.rows).toHaveLength(PAGE_SIZE);
                expect(first.results).toEqual(FLAG_COMBINATIONS.map(() => first.rows));
                // Every character and group the page holds, not just the ones extensions are shown.
                const loaded = await page.evaluate(async () => {
                    const { characters } = await import('/scripts/character-store.js');
                    const { groups } = await import('/scripts/group-store.js');
                    return characters.length + groups.length;
                });
                expect(loaded).toBeGreaterThan(PAGE_SIZE);

                await turnPage(page);
                const second = await snapshotList(page);
                expect(second.rows.length).toBeGreaterThan(0);
                expect(second.results).toEqual(FLAG_COMBINATIONS.map(() => second.rows));
                expect(second.rows.filter(key => first.rows.includes(key))).toEqual([]);
            } finally {
                await tearDownList(page, list);
            }
        });
    }

    test('mutating getEntitiesList()\'s result changes neither the page nor a later call\'s result', async ({ page }) => {
        const list = await setUpList(page);
        try {
            const outcome = await page.evaluate(async () => {
                const { getEntitiesList } = await import('/script.js');
                // @ts-ignore
                const keys = window.__entityKeys;
                // @ts-ignore
                const rowsBefore = window.__listRows();
                const first = getEntitiesList();
                const firstKeys = keys(first);
                first.reverse();
                first.push({ type: 'character', id: 'mutated.png', item: { avatar: 'mutated.png', name: 'mutated' } });
                first.splice(0, 2);
                const second = getEntitiesList();
                const secondKeys = keys(second);
                second.length = 0;
                const third = getEntitiesList();
                return {
                    rowsBefore,
                    firstKeys,
                    secondKeys,
                    thirdKeys: keys(third),
                    // @ts-ignore
                    rowsAfter: window.__listRows(),
                    distinctArrays: first !== second && second !== third && first !== third,
                };
            });
            expect(outcome.rowsBefore).toHaveLength(PAGE_SIZE);
            expect(outcome.firstKeys).toEqual(outcome.rowsBefore);
            expect(outcome.secondKeys).toEqual(outcome.rowsBefore);
            expect(outcome.thirdKeys).toEqual(outcome.rowsBefore);
            expect(outcome.rowsAfter).toEqual(outcome.rowsBefore);
            expect(outcome.distinctArrays).toBe(true);
        } finally {
            await tearDownList(page, list);
        }
    });

    test('before the list first renders, getEntitiesList() returns []', async ({ page }) => {
        const [avatar] = await createCharacters(page, 'IdxEntitiesBoot', 1);
        try {
            // Holds every /query request, the first page's among them, so the reloaded page can't render the list.
            const held = [];
            let released = false;
            await page.route('**/api/characters/query', async (route) => {
                if (released) {
                    await route.continue();
                } else {
                    held.push(route);
                }
            });
            await page.reload();
            await expect.poll(() => held.length, { timeout: 60000 }).toBeGreaterThan(0);
            const beforeRender = await page.evaluate(async (combinations) => {
                const { getEntitiesList } = await import('/script.js');
                return {
                    preloader: document.getElementById('preloader') !== null,
                    listChildren: document.getElementById('rm_print_characters_block').childElementCount,
                    results: combinations.map((options) => {
                        const result = options === null ? getEntitiesList() : getEntitiesList(options);
                        return { isArray: Array.isArray(result), length: result.length };
                    }),
                };
            }, FLAG_COMBINATIONS);
            expect(beforeRender).toEqual({
                preloader: true,
                listChildren: 0,
                results: FLAG_COMBINATIONS.map(() => ({ isArray: true, length: 0 })),
            });

            released = true;
            for (const route of held) {
                await route.continue();
            }
            await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 60000 });
            await installListProbe(page);
            // @ts-ignore
            await expect.poll(() => page.evaluate(() => window.__listRows())).toContain(`character:${avatar}`);
            const afterRender = await snapshotList(page);
            expect(afterRender.results).toEqual(FLAG_COMBINATIONS.map(() => afterRender.rows));
        } finally {
            await deleteCharacters(page, [avatar]);
        }
    });

    test('upstream\'s getEntitiesList() patterns work on the page: a pagination dataSource, .findIndex, and .filter(fav).slice(0, 25)', async ({ page }) => {
        const list = await setUpList(page);
        try {
            const outcome = await page.evaluate(async ({ pageSize, avatars, favs }) => {
                const { getEntitiesList } = await import('/script.js');
                // @ts-ignore
                const keys = window.__entityKeys;
                // No await until the pagination below, so every call sees the render the rows came from.
                // @ts-ignore
                const rows = window.__listRows();
                // @ts-ignore
                const favRows = window.__listFavRows();

                // Upstream's select_rm_info post-import page jump.
                const avatarIndices = avatars.map((avatarFileName) => {
                    const charData = getEntitiesList({ doFilter: true });
                    return charData.findIndex((x) => x?.item?.avatar?.startsWith(avatarFileName));
                });
                // Upstream's select_rm_info post-create group page jump, for a group not on the page.
                const groupIndex = getEntitiesList({ doFilter: true }).findIndex((x) => String(x?.item?.id) === String('no-such-group'));

                // Upstream's favsToHotswap.
                const entities = getEntitiesList({ doFilter: false });
                const FAVS_LIMIT = 25;
                const hotswapFavs = keys(entities.filter(x => x.item.fav || x.item.fav == 'true').slice(0, FAVS_LIMIT));

                // Upstream's printCharacters pagination, on a pager of its own.
                const pagedEntities = getEntitiesList({ doFilter: true });
                const holder = document.createElement('div');
                document.body.append(holder);
                let paged;
                let pagingError = null;
                try {
                    paged = await new Promise((resolve) => {
                        // @ts-ignore
                        $(holder).pagination({ dataSource: pagedEntities, pageSize, callback: (data) => resolve(keys(data)) });
                    });
                } catch (error) {
                    pagingError = String(error);
                } finally {
                    // @ts-ignore
                    $(holder).pagination('destroy');
                    holder.remove();
                }

                return {
                    rows,
                    favRows,
                    avatarIndices,
                    expectedAvatarIndices: avatars.map(avatar => rows.indexOf(`character:${avatar}`)),
                    groupIndex,
                    hotswapFavs,
                    favsOffPage: favs.filter(avatar => !rows.includes(`character:${avatar}`)).length,
                    paged,
                    pagingError,
                };
            }, { pageSize: PAGE_SIZE, avatars: list.avatars, favs: list.favs });

            expect(outcome.rows).toHaveLength(PAGE_SIZE);
            // A position within the page for an avatar on it, -1 for one elsewhere, and both kinds are here.
            expect(outcome.avatarIndices).toEqual(outcome.expectedAvatarIndices);
            expect(outcome.avatarIndices.some(index => index >= 0)).toBe(true);
            expect(outcome.avatarIndices.some(index => index === -1)).toBe(true);
            expect(outcome.groupIndex).toBe(-1);
            // The favourites on the page, and some favourites are on other pages.
            expect(outcome.favRows.length).toBeGreaterThan(0);
            expect(outcome.favsOffPage).toBeGreaterThan(0);
            expect(outcome.hotswapFavs).toEqual(outcome.favRows);
            expect(outcome.pagingError).toBeNull();
            expect(outcome.paged).toEqual(outcome.rows);
        } finally {
            await tearDownList(page, list);
        }
    });
});
