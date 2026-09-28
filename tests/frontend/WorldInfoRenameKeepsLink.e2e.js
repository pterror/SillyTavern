import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Renaming a lorebook deletes the old file, but the open character is not unlinked from it the way a delete
// unlinks it: it keeps the old name like every other linked character, and the relink prompt decides for all
// of them. Before, its delayed unlink landed after the relink and cleared its link.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * Creates characters through the API, each with `world` as its primary lorebook.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} names
 * @param {string} world
 * @returns {Promise<string[]>} The avatar filenames, in the order of `names`.
 */
async function createCharacters(page, names, world) {
    return page.evaluate(async ({ names, world }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const avatars = [];
        for (const name of names) {
            const form = new FormData();
            form.set('ch_name', name);
            form.set('first_mes', 'Hello');
            form.set('world', world);
            const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
            if (!response.ok) throw new Error(`create failed: ${response.status}`);
            avatars.push(await response.text());
        }
        return avatars;
    }, { names, world });
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
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<string>} The stored card's primary lorebook.
 */
async function storedWorld(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        const card = await response.json();
        return String(card?.data?.extensions?.world ?? '');
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} worldNames
 */
async function deleteWorlds(page, worldNames) {
    await page.evaluate(async (worldNames) => {
        const worldInfo = await import('./scripts/world-info.js');
        await worldInfo.updateWorldInfoList();
        for (const name of worldNames) {
            if (worldInfo.world_names.includes(name)) {
                await worldInfo.deleteWorldInfo(name);
            }
        }
    }, worldNames);
}

/**
 * Renames `oldName` to `newName` through the editor's rename button, answering the relink prompt with `relink`,
 * and waits for the rename to finish. Then starts any delayed character field save and waits for all of them.
 * @param {import('@playwright/test').Page} page
 * @param {string} oldName
 * @param {string} newName
 * @param {boolean} relink
 * @returns {Promise<{ confirmAsked: boolean }>}
 */
async function renameWorld(page, oldName, newName, relink) {
    return page.evaluate(async ({ oldName, newName, relink }) => {
        const { openWorldInfoEditor } = await import('./scripts/world-info.js');
        const { Popup, POPUP_RESULT } = await import('./scripts/popup.js');
        const { flushCharacterFieldSaves } = await import('/script.js');

        const originalInput = Popup.show.input;
        const originalConfirm = Popup.show.confirm;
        let confirmAsked = false;
        let finish;
        const finished = new Promise(resolve => finish = resolve);
        try {
            await openWorldInfoEditor(oldName);
            Popup.show.input = async () => newName;
            Popup.show.confirm = async () => {
                confirmAsked = true;
                return relink ? POPUP_RESULT.AFFIRMATIVE : POPUP_RESULT.NEGATIVE;
            };
            // The editor switches to the new name as the rename's last step, after the relink. The deletion before
            // the relink prompt triggers a change too.
            const onChange = () => {
                if (confirmAsked && String($('#world_editor_select').find(':selected').text()) === newName) {
                    $('#world_editor_select').off('change', onChange);
                    finish();
                }
            };
            $('#world_editor_select').on('change', onChange);
            document.querySelector('#world_popup_name_button').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('rename did not finish')), 15000))]);
        } finally {
            Popup.show.input = originalInput;
            Popup.show.confirm = originalConfirm;
        }
        await flushCharacterFieldSaves();
        return { confirmAsked };
    }, { oldName, newName, relink });
}

test.describe('renaming a lorebook the open character links to', () => {
    test.beforeEach(testSetup.awaitST);

    // keptName: which of the two names every linked character is left linked to.
    for (const { relink, answer, keptName } of [
        { relink: true, answer: 'accepted', keptName: 'new' },
        { relink: false, answer: 'declined', keptName: 'old' },
    ]) {
        test(`the open character follows the other linked characters when the relink is ${answer}`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const oldName = `WI_RENAME_LINK_OLD_${s}`;
            const newName = `WI_RENAME_LINK_NEW_${s}`;
            // Index 0 is opened in the editor; 1 is another linked character.
            const names = [`WIRenameLink-${s}-0`, `WIRenameLink-${s}-1`];

            await page.evaluate(async (oldName) => {
                const { createNewWorldInfo } = await import('./scripts/world-info.js');
                if (!await createNewWorldInfo(oldName, { interactive: false })) {
                    throw new Error(`Failed to create world info '${oldName}'`);
                }
            }, oldName);
            const avatars = await createCharacters(page, names, oldName);
            try {
                await openCharacterManagementDrawer(page);
                await page.evaluate(async (avatar) => {
                    // @ts-ignore
                    await SillyTavern.getContext().getCharacters();
                    const { selectCharacterByAvatar } = await import('/script.js');
                    await selectCharacterByAvatar(avatar);
                }, avatars[0]);
                await expect(page.locator('#avatar_url_pole')).toHaveValue(avatars[0], { timeout: 10000 });
                await expect(page.locator('#character_world')).toHaveValue(oldName);

                const { confirmAsked } = await renameWorld(page, oldName, newName, relink);
                expect(confirmAsked).toBe(true);

                const expected = { new: newName, old: oldName }[keptName];
                expect(await storedWorld(page, avatars[0])).toBe(expected);
                expect(await storedWorld(page, avatars[1])).toBe(expected);
                await expect(page.locator('#character_world')).toHaveValue(expected);
            } finally {
                await deleteWorlds(page, [oldName, newName]);
                await deleteCharacters(page, avatars);
            }
        });
    }
});
