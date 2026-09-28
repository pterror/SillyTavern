import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// Renaming a lorebook doesn't warn which characters still have the old name as their primary lorebook before the
// relink prompt: that list is out of date as soon as the answer is yes. After the prompt, the characters left on
// the old name (declined, or the relink failed) are listed.

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
 * and waits for the rename to finish.
 * @param {import('@playwright/test').Page} page
 * @param {string} oldName
 * @param {string} newName
 * @param {boolean} relink
 * @returns {Promise<{ confirmAsked: boolean, warningsAtPrompt: string[] }>} warningsAtPrompt: the text of every
 * warning toast naming `oldName` on screen when the relink prompt was asked.
 */
async function renameWorld(page, oldName, newName, relink) {
    return page.evaluate(async ({ oldName, newName, relink }) => {
        const { openWorldInfoEditor } = await import('./scripts/world-info.js');
        const { Popup, POPUP_RESULT } = await import('./scripts/popup.js');

        const originalInput = Popup.show.input;
        const originalConfirm = Popup.show.confirm;
        let confirmAsked = false;
        /** @type {string[]} */
        let warningsAtPrompt = [];
        let finish;
        const finished = new Promise(resolve => finish = resolve);
        try {
            await openWorldInfoEditor(oldName);
            Popup.show.input = async () => newName;
            Popup.show.confirm = async () => {
                confirmAsked = true;
                warningsAtPrompt = Array.from(document.querySelectorAll('#toast-container .toast-warning .toast-message'))
                    .map(element => element.textContent ?? '')
                    .filter(text => text.includes(oldName));
                return relink ? POPUP_RESULT.AFFIRMATIVE : POPUP_RESULT.NEGATIVE;
            };
            // The editor switches to the new name as the rename's last step, after the relink and its warning.
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
        return { confirmAsked, warningsAtPrompt };
    }, { oldName, newName, relink });
}

const warningsNaming = (page, worldName) => page.locator('#toast-container .toast-warning .toast-message', { hasText: worldName });

test.describe('renaming a lorebook characters link to', () => {
    test.beforeEach(testSetup.awaitST);

    // relinkFails: the relink request is answered with an error.
    for (const { relink, relinkFails, title, left } of [
        { relink: true, relinkFails: false, title: 'no warning when the relink is accepted', left: false },
        { relink: false, relinkFails: false, title: 'lists the characters left on the old name after the relink is declined', left: true },
        { relink: true, relinkFails: true, title: 'lists the characters left on the old name after the relink fails', left: true },
    ]) {
        test(`warns nothing before the relink prompt, and ${title}`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const oldName = `WI_RENAME_WARN_OLD_${s}`;
            const newName = `WI_RENAME_WARN_NEW_${s}`;
            const names = [`WIRenameWarn-${s}-0`, `WIRenameWarn-${s}-1`];

            await page.evaluate(async (oldName) => {
                const { createNewWorldInfo } = await import('./scripts/world-info.js');
                if (!await createNewWorldInfo(oldName, { interactive: false })) {
                    throw new Error(`Failed to create world info '${oldName}'`);
                }
            }, oldName);
            const avatars = await createCharacters(page, names, oldName);
            try {
                if (relinkFails) {
                    await page.route('**/api/characters/merge-attributes', route => route.fulfill({ status: 500, body: 'synthetic relink failure' }));
                }
                let result;
                try {
                    result = await renameWorld(page, oldName, newName, relink);
                } finally {
                    if (relinkFails) {
                        await page.unroute('**/api/characters/merge-attributes');
                    }
                }
                expect(result.confirmAsked).toBe(true);
                expect(result.warningsAtPrompt).toEqual([]);

                const expected = left ? oldName : newName;
                expect(await storedWorld(page, avatars[0])).toBe(expected);
                expect(await storedWorld(page, avatars[1])).toBe(expected);

                const warnings = warningsNaming(page, oldName);
                if (!left) {
                    await expect(warnings).toHaveCount(0);
                    return;
                }
                await expect(warnings).toHaveCount(1);
                const text = await warnings.innerText();
                expect(text).toContain(`Renamed lorebook ${oldName} to ${newName}, but 2 character(s) still have ${oldName} as their primary lorebook:`);
                expect(text).toContain(names.join(', '));
                expect(text).not.toContain('more.');
            } finally {
                await deleteWorlds(page, [oldName, newName]);
                await deleteCharacters(page, avatars);
            }
        });
    }
});
