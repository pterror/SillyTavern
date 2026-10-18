import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// public/scripts modules keep upstream's exports, with upstream's signatures and what callers rely on
// (scripts/script-exports.mjs checks names and signatures; these check the behaviour behind them).

test.describe('public/scripts modules keep upstream\'s exports', () => {
    test.beforeEach(testSetup.awaitST);

    test('duplicateWorldInfoEntry(data, uid) is synchronous; the copy is stored by the book\'s save, or at once with its name', async ({ page }) => {
        const name = `WIDuplicateSync-${Date.now()}`;
        const result = await page.evaluate(async ({ name }) => {
            const wi = await import('./scripts/world-info.js');
            const { getRequestHeaders } = await import('./script.js');
            if (!await wi.createNewWorldInfo(name, { interactive: false })) throw new Error(`Could not create '${name}'`);
            const data = await wi.loadWorldInfo(name);
            data.entries[0] = { uid: 0, ...structuredClone(wi.newWorldInfoEntryTemplate), comment: 'source', key: ['k'] };
            await wi.saveWorldInfo(name, data, true);
            const copy = wi.duplicateWorldInfoEntry(data, 0);
            const synchronous = !(copy instanceof Promise);
            const inData = data.entries[copy.uid] === copy;
            await wi.saveWorldInfo(name, data, true);
            const named = wi.duplicateWorldInfoEntry(data, 0, name);
            await wi.saveWorldInfoEntry(name, data, named.uid, true);
            const stored = await (await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name }) })).json();
            await wi.deleteWorldInfo(name);
            return {
                synchronous, inData, uids: [copy.uid, named.uid],
                stored: Object.fromEntries(Object.entries(stored.entries).map(([k, e]) => [k, [e.comment, e.key]])),
            };
        }, { name });
        expect(result.synchronous).toBe(true);
        expect(result.inData).toBe(true);
        expect(result.uids).toEqual([1, 2]);
        expect(result.stored).toEqual({ 0: ['source', ['k']], 1: ['source', ['k']], 2: ['source', ['k']] });
    });

    test('charSetAuxWorlds is synchronous and the page\'s list holds the new books when it returns', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const wi = await import('./scripts/world-info.js');
            const fileName = `aux-${Date.now()}`;
            const returned = wi.charSetAuxWorlds(fileName, ['A', 'B']);
            const entry = wi.world_info.charLore?.find(e => e.name === fileName);
            return { returned: returned === undefined, books: entry?.extraBooks };
        });
        expect(result.returned).toBe(true);
        expect(result.books).toEqual(['A', 'B']);
    });

    test('getGroupMembers is synchronous; editGroup stores a change made to a group in place, and only that field', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const ctx = SillyTavern.getContext();
            const groupChats = await import('./scripts/group-chats.js');
            const response = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name: `EditGroup ${Date.now()}`, members: [] }) });
            if (!response.ok) throw new Error(`group create failed: ${response.status}`);
            const id = String((await response.json()).id);
            await ctx.getCharacters({ silentGroups: true });
            const members = groupChats.getGroupMembers(id);
            /** @type {any[]} */
            const sent = [];
            const realFetch = window.fetch;
            window.fetch = (input, init) => {
                if (String(input).endsWith('/api/groups/save-partial')) sent.push(JSON.parse(String(init?.body)).props);
                return realFetch(input, init);
            };
            try {
                groupChats.groupsStore.get(id).fav = true;
                await groupChats.editGroup(id, true, false);
                await groupChats.editGroup(id, true, false);
            } finally {
                window.fetch = realFetch;
            }
            const all = await (await fetch('/api/groups/all', { method: 'POST', headers: ctx.getRequestHeaders() })).json();
            const stored = all.find((/** @type {any} */ g) => String(g.id) === id);
            await fetch('/api/groups/delete', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ id }) });
            return { membersIsArray: Array.isArray(members), members: members.length, sent, fav: stored?.fav };
        });
        expect(result.membersIsArray).toBe(true);
        expect(result.members).toBe(0);
        // The second call finds nothing changed since the first was stored.
        expect(result.sent).toEqual([{ fav: true }]);
        expect(result.fav).toBe(true);
    });

    test('restored exports: parser, getCharIndex, getStreamingReply, ELSE_MARKER, itemized prompt helpers, tts/openai.js', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { parser } = await import('./scripts/slash-commands.js');
            const { SlashCommandParser } = await import('./scripts/slash-commands/SlashCommandParser.js');
            const { getCharIndex } = await import('./scripts/utils.js');
            const { getStreamingReply } = await import('./scripts/openai.js');
            const { ELSE_MARKER } = await import('./scripts/macros/definitions/core-macros.js');
            const constants = await import('./scripts/macros/engine/MacroConstants.js');
            const itemized = await import('./scripts/itemized-prompts.js');
            const tts = await import('./scripts/extensions/tts/openai.js');
            let undefinedThrows = false;
            try {
                getCharIndex(undefined);
            } catch {
                undefinedThrows = true;
            }
            const state = { reasoning: '', images: [], signature: null, toolSignatures: {} };
            return {
                parserIsInstance: parser instanceof SlashCommandParser,
                undefinedThrows,
                reply: getStreamingReply({ choices: [{ delta: { content: 'hi' } }] }, state, { chatCompletionSource: 'openai' }),
                elseMarker: ELSE_MARKER === constants.ELSE_MARKER,
                swapSync: itemized.swapItemizedPrompts(0, 1) === undefined,
                deleteSync: itemized.deleteItemizedPromptForMessage(0) === undefined,
                tts: typeof tts.OpenAITtsProvider,
            };
        });
        expect(result).toEqual({
            parserIsInstance: true,
            undefinedThrows: true,
            reply: 'hi',
            elseMarker: true,
            swapSync: true,
            deleteSync: true,
            tts: 'function',
        });
    });
});
