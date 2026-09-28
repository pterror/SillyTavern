import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// A World Info write the server refuses (or never receives) shows an error toast naming what wasn't saved,
// and nothing that depends on the file - linking a card to it, deleting the old file on rename, reporting
// success - goes ahead without it. The failures are injected with page.route(). A book can't be written under
// the embedded lorebook's name at all, and the user is told the same way.

/**
 * Wraps toastr.error/success and WORLDINFO_UPDATED so the test can read what the page reported.
 * @param {import('@playwright/test').Page} page
 */
async function recordReports(page) {
    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('./script.js');
        const reports = { error: [], success: [], updated: [] };
        // @ts-ignore
        window.__wiReports = reports;
        for (const kind of ['error', 'success']) {
            const original = window.toastr[kind];
            window.toastr[kind] = (...args) => {
                reports[kind].push(args.map(String).join(' | '));
                return original.apply(window.toastr, args);
            };
        }
        eventSource.on(event_types.WORLDINFO_UPDATED, (name) => reports.updated.push(name));
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{error: string[], success: string[], updated: string[]}>}
 */
async function readReports(page) {
    // @ts-ignore
    return await page.evaluate(() => structuredClone(window.__wiReports));
}

/**
 * The book names the server lists right now.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>}
 */
async function serverBookNames(page) {
    return await page.evaluate(async () => {
        const { getRequestHeaders } = await import('./script.js');
        const response = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) });
        const data = await response.json();
        return data.world_names ?? [];
    });
}

/**
 * Creates a character through the UI, selects it, and gives it an embedded book named `bookName` with one
 * entry keyed `savefailurekey`.
 * @param {import('@playwright/test').Page} page
 * @param {string} name Character name
 * @param {string} bookName Name of the embedded book
 * @returns {Promise<string>} The character's avatar
 */
async function createCharacterWithEmbeddedBook(page, name, bookName) {
    let avatar = null;

    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    page.once('console', msg => {
        const text = msg.text();
        if (text.startsWith('new avatar id:')) {
            avatar = text.replace('new avatar id:', '').trim();
        }
    });
    await page.locator('#create_button_label').click();
    await expect.poll(() => avatar, { timeout: 10000 }).not.toBeNull();

    await page.evaluate(async ({ avatar, bookName }) => {
        const { checkEmbeddedWorld } = await import('./scripts/world-info.js');
        const { selectCharacterByAvatar, saveCharacterField } = await import('./script.js');
        await selectCharacterByAvatar(avatar);
        const characterBook = {
            name: bookName,
            extensions: {},
            entries: [
                { id: 0, keys: ['savefailurekey'], content: 'save failure content', enabled: true, insertion_order: 0, extensions: {} },
            ],
        };
        const characterBookJson = JSON.stringify(characterBook);
        $('#character_book_json').val(characterBookJson);
        if (!await saveCharacterField(avatar, '#character_book_json', characterBookJson)) {
            throw new Error('Could not save the embedded book onto the test character');
        }
        if (!checkEmbeddedWorld(avatar)) {
            throw new Error('The test character has no embedded book');
        }
    }, { avatar, bookName });

    return avatar;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function deleteCharacter(page, avatar) {
    await page.evaluate(async (avatar) => {
        const { getRequestHeaders } = await import('./script.js');
        await fetch('/api/characters/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, delete_chats: true }),
        });
    }, avatar);
}

/**
 * Clicks an editor button with Popup.show.input answering `answer`, then waits until the page has shown
 * `errorCount` error toasts in all.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 * @param {string} answer
 * @param {number} errorCount
 */
async function clickWithInput(page, selector, answer, errorCount) {
    await page.evaluate(async ({ selector, answer, errorCount }) => {
        const { Popup } = await import('./scripts/popup.js');
        const originalInput = Popup.show.input;
        Popup.show.input = async () => answer;
        try {
            document.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            const start = Date.now();
            // @ts-ignore
            while (window.__wiReports.error.length < errorCount && Date.now() - start < 5000) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        } finally {
            Popup.show.input = originalInput;
        }
    }, { selector, answer, errorCount });
}

test.describe('a failed World Info write', () => {
    test.beforeEach(testSetup.awaitST);

    test('Import Card Lore neither links the card nor reports success when the book is not written', async ({ page }) => {
        const name = `WISaveFailureImport-${Date.now()}`;
        const bookName = `${name} Book`;

        const linkRequests = [];
        page.on('request', request => {
            if (request.url().endsWith('/api/characters/merge-attributes') && (request.postData() ?? '').includes('"world"')) {
                linkRequests.push(request.postData());
            }
        });

        const avatar = await createCharacterWithEmbeddedBook(page, name, bookName);

        try {
            await recordReports(page);
            await page.route('**/api/worldinfo/edit', route => route.fulfill({ status: 500, body: 'Internal Server Error' }));

            const failed = await page.evaluate(async ({ avatar, bookName }) => {
                const { importEmbeddedWorldInfo, world_names, worldInfoCache } = await import('./scripts/world-info.js');
                const { flushCharacterFieldSaves } = await import('./script.js');
                const { charactersStore } = await import('./scripts/character-store.js');
                await importEmbeddedWorldInfo(true);
                await flushCharacterFieldSaves();
                return {
                    characterWorldField: String($('#character_world').val() ?? ''),
                    storedWorld: charactersStore.get(avatar)?.data?.extensions?.world ?? '',
                    listed: world_names.includes(bookName),
                    cached: worldInfoCache.has(bookName),
                    globeOn: $('#set_character_world').hasClass('world_set'),
                };
            }, { avatar, bookName });

            const failedReports = await readReports(page);
            expect(failedReports.error).toHaveLength(1);
            expect(failedReports.error[0]).toContain(`'${bookName}' was not saved.`);
            expect(failedReports.success).toEqual([]);
            expect(failedReports.updated).toEqual([]);
            expect(failed.characterWorldField).not.toBe(bookName);
            expect(failed.storedWorld).not.toBe(bookName);
            expect(failed.listed).toBe(false);
            expect(failed.cached).toBe(false);
            expect(failed.globeOn).toBe(false);
            expect(linkRequests).toEqual([]);
            expect(await serverBookNames(page)).not.toContain(bookName);

            // Once the write goes through, the same import links the card and reports success.
            await page.unroute('**/api/worldinfo/edit');
            const imported = await page.evaluate(async ({ avatar }) => {
                const { importEmbeddedWorldInfo } = await import('./scripts/world-info.js');
                const { flushCharacterFieldSaves } = await import('./script.js');
                const { charactersStore } = await import('./scripts/character-store.js');
                await importEmbeddedWorldInfo(true);
                await flushCharacterFieldSaves();
                return { storedWorld: charactersStore.get(avatar)?.data?.extensions?.world ?? '' };
            }, { avatar });

            const importedReports = await readReports(page);
            expect(importedReports.error).toHaveLength(1);
            expect(importedReports.success).toHaveLength(1);
            expect(importedReports.updated).toContain(bookName);
            expect(imported.storedWorld).toBe(bookName);
            expect(await serverBookNames(page)).toContain(bookName);
        } finally {
            await page.unroute('**/api/worldinfo/edit');
            await page.evaluate(async ({ bookName }) => {
                const { deleteWorldInfo, world_names } = await import('./scripts/world-info.js');
                if (world_names.includes(bookName)) {
                    await deleteWorldInfo(bookName);
                }
            }, { bookName });
            await deleteCharacter(page, avatar);
        }
    });

    test('rename keeps the old book when the new one is not written', async ({ page }) => {
        const oldName = `WISaveFailureRenameOld-${Date.now()}`;
        const newName = `WISaveFailureRenameNew-${Date.now()}`;

        await page.evaluate(async ({ oldName }) => {
            const { createNewWorldInfo, openWorldInfoEditor, showWorldEditor } = await import('./scripts/world-info.js');
            if (!await createNewWorldInfo(oldName)) {
                throw new Error(`Could not create '${oldName}'`);
            }
            openWorldInfoEditor(oldName);
            await showWorldEditor(oldName);
        }, { oldName });

        await recordReports(page);
        await page.route('**/api/worldinfo/edit', route => route.fulfill({ status: 500, body: 'Internal Server Error' }));

        try {
            await clickWithInput(page, '#world_popup_name_button', newName, 1);

            const reports = await readReports(page);
            expect(reports.error).toHaveLength(1);
            expect(reports.error[0]).toContain(`'${newName}' was not saved.`);

            const state = await page.evaluate(async ({ oldName, newName }) => {
                const { world_names, worldInfoCache } = await import('./scripts/world-info.js');
                return {
                    oldListed: world_names.includes(oldName),
                    newListed: world_names.includes(newName),
                    newCached: worldInfoCache.has(newName),
                };
            }, { oldName, newName });
            expect(state).toEqual({ oldListed: true, newListed: false, newCached: false });

            const onServer = await serverBookNames(page);
            expect(onServer).toContain(oldName);
            expect(onServer).not.toContain(newName);
        } finally {
            await page.unroute('**/api/worldinfo/edit');
            await page.evaluate(async ({ oldName }) => {
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                await deleteWorldInfo(oldName);
            }, { oldName });
        }
    });

    test('duplicate does not open a copy that was not written', async ({ page }) => {
        const sourceName = `WISaveFailureDuplicateSource-${Date.now()}`;
        const copyName = `WISaveFailureDuplicateCopy-${Date.now()}`;

        await page.evaluate(async ({ sourceName }) => {
            const { createNewWorldInfo, openWorldInfoEditor, showWorldEditor } = await import('./scripts/world-info.js');
            if (!await createNewWorldInfo(sourceName)) {
                throw new Error(`Could not create '${sourceName}'`);
            }
            openWorldInfoEditor(sourceName);
            await showWorldEditor(sourceName);
        }, { sourceName });

        await recordReports(page);
        await page.route('**/api/worldinfo/edit', route => route.fulfill({ status: 500, body: 'Internal Server Error' }));

        try {
            await clickWithInput(page, '#world_duplicate', copyName, 1);

            const reports = await readReports(page);
            expect(reports.error).toHaveLength(1);
            expect(reports.error[0]).toContain(`'${copyName}' was not saved.`);

            const state = await page.evaluate(async ({ copyName }) => {
                const { world_names, worldInfoCache } = await import('./scripts/world-info.js');
                return {
                    copyListed: world_names.includes(copyName),
                    copyCached: worldInfoCache.has(copyName),
                    editorBook: String($('#world_editor_select').find(':selected').text()),
                };
            }, { copyName });
            expect(state.copyListed).toBe(false);
            expect(state.copyCached).toBe(false);
            expect(state.editorBook).not.toBe(copyName);
            expect(await serverBookNames(page)).not.toContain(copyName);
        } finally {
            await page.unroute('**/api/worldinfo/edit');
            await page.evaluate(async ({ sourceName }) => {
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                await deleteWorldInfo(sourceName);
            }, { sourceName });
        }
    });

    test('createNewWorldInfo() does not report a book that was not written', async ({ page }) => {
        const refusedName = `WISaveFailureCreateRefused-${Date.now()}`;
        const unreachableName = `WISaveFailureCreateUnreachable-${Date.now()}`;

        await recordReports(page);

        await page.route('**/api/worldinfo/edit', route => route.fulfill({ status: 500, body: 'Internal Server Error' }));
        const refused = await page.evaluate(async ({ refusedName }) => {
            const { createNewWorldInfo, world_names, worldInfoCache } = await import('./scripts/world-info.js');
            const created = await createNewWorldInfo(refusedName);
            return { created, listed: world_names.includes(refusedName), cached: worldInfoCache.has(refusedName) };
        }, { refusedName });
        await page.unroute('**/api/worldinfo/edit');

        expect(refused).toEqual({ created: false, listed: false, cached: false });

        // A request that never reaches the server still rejects, and shows the same toast first.
        await page.route('**/api/worldinfo/edit', route => route.abort('failed'));
        const unreachable = await page.evaluate(async ({ unreachableName }) => {
            const { createNewWorldInfo, world_names, worldInfoCache } = await import('./scripts/world-info.js');
            let rejected = false;
            try {
                await createNewWorldInfo(unreachableName);
            } catch {
                rejected = true;
            }
            return { rejected, listed: world_names.includes(unreachableName), cached: worldInfoCache.has(unreachableName) };
        }, { unreachableName });
        await page.unroute('**/api/worldinfo/edit');

        expect(unreachable).toEqual({ rejected: true, listed: false, cached: false });

        const reports = await readReports(page);
        expect(reports.error).toHaveLength(2);
        expect(reports.error[0]).toContain(`'${refusedName}' was not saved. Check the server console for details.`);
        expect(reports.error[1]).toContain(`'${unreachableName}' was not saved. Check the server connection.`);
        expect(reports.updated).toEqual([]);

        const onServer = await serverBookNames(page);
        expect(onServer).not.toContain(refusedName);
        expect(onServer).not.toContain(unreachableName);
    });

    test('a debounced book save that fails shows which book was not saved', async ({ page }) => {
        const bookName = `WISaveFailureDebounced-${Date.now()}`;

        await page.evaluate(async ({ bookName }) => {
            const { createNewWorldInfo } = await import('./scripts/world-info.js');
            if (!await createNewWorldInfo(bookName)) {
                throw new Error(`Could not create '${bookName}'`);
            }
        }, { bookName });

        await recordReports(page);
        await page.route('**/api/worldinfo/edit', route => route.fulfill({ status: 500, body: 'Internal Server Error' }));

        try {
            await page.evaluate(async ({ bookName }) => {
                const { loadWorldInfo, saveWorldInfo } = await import('./scripts/world-info.js');
                const data = await loadWorldInfo(bookName);
                data.entries['0'] = { uid: 0, key: ['debounced'], content: 'debounced content', comment: 'debounced' };
                await saveWorldInfo(bookName, data);
            }, { bookName });

            await expect.poll(async () => (await readReports(page)).error.length, { timeout: 10000 }).toBe(1);
            const reports = await readReports(page);
            expect(reports.error[0]).toContain(`'${bookName}' was not saved.`);
            expect(reports.updated).toEqual([]);
        } finally {
            await page.unroute('**/api/worldinfo/edit');
            await page.evaluate(async ({ bookName }) => {
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                await deleteWorldInfo(bookName);
            }, { bookName });
        }
    });

    test('an entry save that fails names the entry, and the other pending entries are still saved', async ({ page }) => {
        const bookName = `WISaveFailureEntry-${Date.now()}`;

        const uids = await page.evaluate(async ({ bookName }) => {
            const { createNewWorldInfo, createWorldInfoEntry, loadWorldInfo, saveWorldInfoEntry } = await import('./scripts/world-info.js');
            if (!await createNewWorldInfo(bookName)) {
                throw new Error(`Could not create '${bookName}'`);
            }
            const data = await loadWorldInfo(bookName);
            const first = await createWorldInfoEntry(bookName, data);
            const second = await createWorldInfoEntry(bookName, data);
            if (!first || !second) {
                throw new Error('Could not create the test entries');
            }
            // Give the file both entries' starting state, so only the edits below are in question.
            if (!await saveWorldInfoEntry(bookName, data, first.uid, true) || !await saveWorldInfoEntry(bookName, data, second.uid, true)) {
                throw new Error('Could not save the test entries');
            }
            return { first: first.uid, second: second.uid };
        }, { bookName });

        await recordReports(page);
        let entryRequests = 0;
        await page.route('**/api/worldinfo/entry/edit', route => {
            entryRequests++;
            return entryRequests === 1 ? route.abort('failed') : route.continue();
        });

        try {
            await page.evaluate(async ({ bookName, uids }) => {
                const { loadWorldInfo, saveWorldInfoEntry } = await import('./scripts/world-info.js');
                const data = await loadWorldInfo(bookName);
                data.entries[uids.first].comment = 'first edit';
                await saveWorldInfoEntry(bookName, data, uids.first);
                data.entries[uids.second].comment = 'second edit';
                await saveWorldInfoEntry(bookName, data, uids.second);
            }, { bookName, uids });

            const readSavedComments = async () => await page.evaluate(async ({ bookName, uids }) => {
                const { getRequestHeaders } = await import('./script.js');
                const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: bookName }) });
                const data = await response.json();
                return { first: data.entries[uids.first]?.comment ?? '', second: data.entries[uids.second]?.comment ?? '' };
            }, { bookName, uids });

            await expect.poll(async () => (await readSavedComments()).second, { timeout: 10000 }).toBe('second edit');
            expect((await readSavedComments()).first).not.toBe('first edit');
            expect(entryRequests).toBe(2);

            const reports = await readReports(page);
            expect(reports.error).toHaveLength(1);
            expect(reports.error[0]).toContain(`Entry ${uids.first} (first edit) in '${bookName}' was not saved. Check the server connection.`);
            expect(reports.updated).toEqual([bookName]);
        } finally {
            await page.unroute('**/api/worldinfo/entry/edit');
            await page.evaluate(async ({ bookName }) => {
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                await deleteWorldInfo(bookName);
            }, { bookName });
        }
    });

    test('a book is never written under the embedded lorebook\'s name, and the user is told', async ({ page }) => {
        const reserved = '__embedded__';
        const oldName = `WISaveFailureReserved-${Date.now()}`;

        // A character whose embedded book is itself named `__embedded__`, open in the embedded lorebook editor,
        // so a write under that name would have somewhere to land: this card.
        const avatar = await createCharacterWithEmbeddedBook(page, `WISaveFailureReservedChar-${Date.now()}`, reserved);

        try {
            await page.evaluate(async ({ avatar, oldName }) => {
                const { openEmbeddedLoreEditor, createNewWorldInfo, openWorldInfoEditor, showWorldEditor } = await import('./scripts/world-info.js');
                await openEmbeddedLoreEditor(avatar);
                if (!await createNewWorldInfo(oldName)) {
                    throw new Error(`Could not create '${oldName}'`);
                }
                openWorldInfoEditor(oldName);
                await showWorldEditor(oldName);
            }, { avatar, oldName });

            await recordReports(page);
            const writes = [];
            page.on('request', request => {
                const url = request.url();
                if (['/api/worldinfo/edit', '/api/worldinfo/delete', '/api/characters/merge-attributes'].some(path => url.endsWith(path))) {
                    writes.push(url);
                }
            });

            await clickWithInput(page, '#world_popup_name_button', reserved, 1);
            await clickWithInput(page, '#world_duplicate', reserved, 2);
            const after = await page.evaluate(async ({ avatar, reserved, oldName }) => {
                const { createNewWorldInfo, importEmbeddedWorldInfo, world_names } = await import('./scripts/world-info.js');
                const { flushCharacterFieldSaves } = await import('./script.js');
                const { charactersStore } = await import('./scripts/character-store.js');
                const created = await createNewWorldInfo(reserved, { interactive: true });
                await importEmbeddedWorldInfo(true);
                await flushCharacterFieldSaves();
                const character = charactersStore.get(avatar);
                return {
                    created,
                    oldListed: world_names.includes(oldName),
                    reservedListed: world_names.includes(reserved),
                    storedWorld: character?.data?.extensions?.world ?? '',
                    embeddedKeys: (character?.data?.character_book?.entries ?? []).flatMap(entry => entry.keys),
                };
            }, { avatar, reserved, oldName });

            const reports = await readReports(page);
            // Rename, duplicate, create and Import Card Lore each say so.
            expect(reports.error).toHaveLength(4);
            for (const error of reports.error) {
                expect(error).toContain(`'${reserved}' was not saved. That name is reserved for embedded lorebooks.`);
            }
            expect(reports.success).toEqual([]);
            expect(writes).toEqual([]);
            expect(after).toEqual({ created: false, oldListed: true, reservedListed: false, storedWorld: '', embeddedKeys: ['savefailurekey'] });

            const onServer = await serverBookNames(page);
            expect(onServer).toContain(oldName);
            expect(onServer).not.toContain(reserved);
        } finally {
            await page.evaluate(async ({ oldName }) => {
                const { deleteWorldInfo, world_names } = await import('./scripts/world-info.js');
                if (world_names.includes(oldName)) {
                    await deleteWorldInfo(oldName);
                }
            }, { oldName });
            await deleteCharacter(page, avatar);
        }
    });
});
