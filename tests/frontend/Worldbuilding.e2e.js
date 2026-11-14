import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { deleteWorld, makeWorld, openWorld } from './worlds.js';

const unique = (/** @type {string} */ name) => `${name} ${Date.now()}${Math.floor(Math.random() * 1000)}`;

/**
 * @param {number} uid
 * @param {string} title
 * @param {string[]} keys
 * @param {string} text
 * @param {{ names?: string[], in?: number, constant?: boolean }} [more]
 */
const entry = (uid, title, keys, text, more = {}) => ({
    uid, key: keys, keysecondary: [], comment: title, content: text, constant: !!more.constant, selective: true, order: 100,
    position: 0, depth: 4, disable: false, probability: 100, useProbability: true, displayIndex: uid,
    extensions: {
        ...(more.names ? { names: more.names } : {}),
        ...(more.in === undefined ? {} : { relations: [{ kind: 1, target: more.in, position: `a${uid}` }] }),
    },
});

const COAST = {
    0: entry(0, 'Saltmarrow', ['Saltmarrow'], 'The last town on the delta that floods on purpose.', { names: ['Saltmarrow'] }),
    1: entry(1, 'The Lantern House', ['The Lantern House'], 'The inn at the top of the stairs in Saltmarrow.', { names: ['The Lantern House'], in: 0 }),
    2: entry(2, 'Ilse Varro', ['Ilse Varro', 'ledger'], 'Ilse keeps the Lantern House.', { names: ['Ilse Varro'], in: 1 }),
    3: entry(3, 'The Tidegate', ['The Tidegate'], 'A stone lock.', { names: ['The Tidegate'], in: 0 }),
};

/**
 * Makes a world with relations of the kind "in", and opens it.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function openCoast(page, name) {
    await makeWorld(page, name, COAST, { relationKinds: [{ id: 1, name: 'in' }] });
}

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding');

/**
 * The entry as upstream stores it.
 * @param {import('@playwright/test').Page} page
 * @param {string} world
 * @param {number} uid
 */
async function storedEntry(page, world, uid) {
    return page.evaluate(async ({ world, uid }) => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const read = await fetch('/api/worldinfo/entry/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: world, uid }) });
        return (await read.json()).entry;
    }, { world, uid });
}

/**
 * Counts the page's actions of `type` while `run` runs.
 * @param {import('@playwright/test').Page} page
 * @param {string} type
 * @param {() => Promise<void>} run
 */
async function actionsDuring(page, type, run) {
    let sent = 0;
    const count = (/** @type {import('@playwright/test').Request} */ request) => {
        if (request.url().endsWith('/api/ui/action') && JSON.parse(request.postData() ?? '{}').type === type) sent++;
    };
    page.on('request', count);
    await run();
    page.off('request', count);
    return sent;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 */
async function openEntry(page, title) {
    await pane(page).locator('.wb-card-open, .wb-region-head', { hasText: title }).first().click();
    await expect(pane(page).locator('.wb-entry .wb-entry-name')).toContainText(title);
}

test.describe('the worlds page', () => {
    test.beforeEach(testSetup.awaitST);

    test('the worlds icon opens a world grouped by its relation: regions hold their members, nested', async ({ page }) => {
        const name = unique('Regions');
        await makeWorld(page, unique('Other'));
        await openCoast(page, name);
        await page.locator('#WIDrawerIcon').click();
        await expect(pane(page)).not.toBeVisible();
        await page.locator('#WIDrawerIcon').click();
        const town = pane(page).locator('.wb-region', { has: page.locator('.wb-region-name', { hasText: 'Saltmarrow' }) }).first();
        await expect(town).toBeVisible();
        await expect(pane(page).locator('.wb-front-meta')).toContainText('4 entries');
        const inn = town.locator('.wb-region', { has: page.locator('.wb-region-name', { hasText: 'The Lantern House' }) });
        await expect(inn.locator('.wb-card', { hasText: 'Ilse Varro' })).toBeVisible();
        await expect(town.locator('.wb-card', { hasText: 'The Tidegate' })).toBeVisible();

        await pane(page).getByLabel('Group by').selectOption({ label: 'None' });
        await expect(pane(page).locator('.wb-region')).toHaveCount(0);
        await expect(pane(page).locator('.wb-card')).toHaveCount(4);
        await deleteWorld(page, name);
    });

    test('an entry opens from its card; its text is edited in place, saved, and names in it are linked', async ({ page }) => {
        const name = unique('Text');
        await openCoast(page, name);
        await openEntry(page, 'The Tidegate');
        await pane(page).getByRole('textbox', { name: 'Content' }).click();
        const editor = pane(page).locator('.cm-content');
        await editor.click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' Ilse Varro keeps its key.');
        await page.keyboard.press('Escape');
        const link = pane(page).locator('.wb-text .wb-link', { hasText: 'Ilse Varro' });
        await expect(link).toBeVisible();
        await page.reload();
        await testSetup.awaitST({ page });
        await openWorld(page, name);
        await openEntry(page, 'The Tidegate');
        await expect(pane(page).locator('.wb-text')).toContainText('A stone lock. Ilse Varro keeps its key.');
        await pane(page).locator('.wb-text .wb-link', { hasText: 'Ilse Varro' }).click();
        await expect(pane(page).locator('.wb-entry .wb-entry-name')).toContainText('Ilse Varro');
        await deleteWorld(page, name);
    });

    test('names and triggers are separate rows: each is added, moved to the other, edited in place and removed', async ({ page }) => {
        const name = unique('Keys');
        await openCoast(page, name);
        await openEntry(page, 'Ilse Varro');
        const names = pane(page).locator('.wb-names');
        const triggers = pane(page).locator('.wb-triggers');
        await expect(names.locator('.wb-keys-label')).toHaveText('Also called');
        await expect(triggers.locator('.wb-keys-label')).toHaveText('Triggers');
        await expect(names.getByLabel('“Ilse Varro”, name', { exact: true })).toBeVisible();
        await expect(triggers.getByLabel('“ledger”, trigger', { exact: true })).toBeVisible();

        await names.getByRole('button', { name: 'Add name' }).click();
        await page.keyboard.type('Ilse');
        await page.keyboard.press('Enter');
        await expect(names.getByLabel('“Ilse”, name', { exact: true })).toBeVisible();
        await triggers.getByRole('button', { name: 'Add trigger' }).click();
        await page.keyboard.type('the innkeeper');
        await page.keyboard.press('Enter');
        await expect(triggers.getByLabel('“the innkeeper”, trigger', { exact: true })).toBeVisible();

        await triggers.getByLabel('“ledger”, trigger', { exact: true }).click();
        await pane(page).locator('.wb-pop').getByRole('button', { name: 'Make it a name' }).click();
        await expect(names.getByLabel('“ledger”, name', { exact: true })).toBeVisible();
        await names.getByLabel('“ledger”, name', { exact: true }).click();
        await pane(page).locator('.wb-pop').getByRole('button', { name: 'Make it a trigger' }).click();
        await expect(triggers.getByLabel('“ledger”, trigger', { exact: true })).toBeVisible();
        await triggers.getByLabel('“ledger”, trigger', { exact: true }).click();
        await pane(page).locator('.wb-pop').getByRole('button', { name: 'Remove' }).click();
        await expect(triggers.getByLabel('“ledger”, trigger', { exact: true })).toHaveCount(0);
        await deleteWorld(page, name);
    });

    test('a key\'s words are edited in place: Enter saves, Escape leaves it, and entries sharing the key keep it', async ({ page }) => {
        const name = unique('Rename');
        await makeWorld(page, name, { ...COAST, 4: entry(4, 'Ledger Hall', ['ledger'], 'Where ledgers are kept.') }, { relationKinds: [{ id: 1, name: 'in' }] });
        await openEntry(page, 'Ilse Varro');
        const names = pane(page).locator('.wb-names');
        const triggers = pane(page).locator('.wb-triggers');
        await expect(triggers.getByLabel('“ledger”, trigger', { exact: true })).toContainText('2 entries');

        await triggers.getByLabel('“ledger”, trigger', { exact: true }).click();
        const field = triggers.getByRole('textbox', { name: 'Edit “ledger”' });
        await expect(field).toHaveValue('ledger');
        await field.fill('account book');
        await page.keyboard.press('Escape');
        await expect(triggers.getByLabel('“ledger”, trigger', { exact: true })).toBeVisible();
        expect((await storedEntry(page, name, 2)).key).toEqual(['Ilse Varro', 'ledger']);

        const renamed = await actionsDuring(page, 'worldbuilding.renameKey', async () => {
            await triggers.getByLabel('“ledger”, trigger', { exact: true }).click();
            await triggers.getByRole('textbox', { name: 'Edit “ledger”' }).fill('ledgers');
            await page.keyboard.press('Enter');
            await expect(triggers.getByLabel('“ledgers”, trigger', { exact: true })).toBeVisible();
        });
        expect(renamed).toBe(1);
        await expect(triggers.getByLabel('“ledgers”, trigger', { exact: true })).not.toContainText('entries');
        expect((await storedEntry(page, name, 2)).key).toEqual(['Ilse Varro', 'ledgers']);
        expect((await storedEntry(page, name, 4)).key).toEqual(['ledger']);

        await names.getByLabel('“Ilse Varro”, name', { exact: true }).click();
        await names.getByRole('textbox', { name: 'Edit “Ilse Varro”' }).fill('Ilse');
        await page.keyboard.press('Enter');
        await expect(names.getByLabel('“Ilse”, name', { exact: true })).toBeVisible();
        const stored = await storedEntry(page, name, 2);
        expect(stored.key).toEqual(['Ilse', 'ledgers']);
        expect(stored.extensions.names).toEqual(['Ilse']);
        await deleteWorld(page, name);
    });

    test('several keys typed or pasted are added at once in one action; a comma inside a pattern stays', async ({ page }) => {
        const name = unique('Several');
        await openCoast(page, name);
        await openEntry(page, 'The Tidegate');
        const triggers = pane(page).locator('.wb-triggers');
        const sent = await actionsDuring(page, 'worldbuilding.addKeys', async () => {
            await triggers.getByRole('button', { name: 'Add trigger' }).click();
            await triggers.getByRole('textbox', { name: 'Trigger' }).fill('a, b, c');
            await page.keyboard.press('Enter');
            for (const key of ['a', 'b', 'c']) await expect(triggers.getByLabel(`“${key}”, trigger`)).toBeVisible();
        });
        expect(sent).toBe(1);
        expect((await storedEntry(page, name, 3)).key).toEqual(['The Tidegate', 'a', 'b', 'c']);

        await triggers.getByRole('button', { name: 'Add trigger' }).click();
        await triggers.getByRole('textbox', { name: 'Trigger' }).fill('/gate{1,2}s/i, d');
        await page.keyboard.press('Enter');
        await expect(triggers.getByLabel('“d”, trigger', { exact: true })).toBeVisible();
        expect((await storedEntry(page, name, 3)).key).toEqual(['The Tidegate', 'a', 'b', 'c', '/gate{1,2}s/i', 'd']);
        await deleteWorld(page, name);
    });

    test('a regex key is a trigger, shown as written in monospace; it can\'t be a name', async ({ page }) => {
        const name = unique('Regex');
        await openCoast(page, name);
        await openEntry(page, 'The Tidegate');
        const names = pane(page).locator('.wb-names');
        const triggers = pane(page).locator('.wb-triggers');
        await triggers.getByRole('button', { name: 'Add trigger' }).click();
        await triggers.getByRole('textbox', { name: 'Trigger' }).fill('/tide ?gates?/i');
        await page.keyboard.press('Enter');
        const chip = triggers.getByLabel('“/tide ?gates?/i”, trigger', { exact: true });
        await expect(chip).toBeVisible();
        await expect(chip).toHaveText('/tide ?gates?/i');
        expect(await chip.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/mono|courier|consolas/i);
        await chip.click();
        await expect(pane(page).locator('.wb-pop').getByRole('button', { name: 'Make it a name' })).toHaveCount(0);
        await page.keyboard.press('Escape');

        await names.getByRole('button', { name: 'Add name' }).click();
        await names.getByRole('textbox', { name: 'Name' }).fill('/gate/');
        await page.keyboard.press('Enter');
        await expect(page.getByText('A pattern can only be a trigger, not a name.').first()).toBeVisible();
        await expect(names.getByLabel('“/gate/”, name', { exact: true })).toHaveCount(0);
        expect((await storedEntry(page, name, 3)).key).toEqual(['The Tidegate', '/tide ?gates?/i']);
        await deleteWorld(page, name);
    });

    test('secondary keys are chips after the logic: added, edited in place and removed', async ({ page }) => {
        const name = unique('Secondary');
        await openCoast(page, name);
        await openEntry(page, 'Ilse Varro');
        const triggers = pane(page).locator('.wb-triggers');
        await triggers.getByRole('button', { name: 'Add secondary trigger' }).click();
        await triggers.getByRole('textbox', { name: 'Secondary trigger' }).fill('harbour, quay');
        await page.keyboard.press('Enter');
        await expect(triggers.getByLabel('“quay”, secondary trigger', { exact: true })).toBeVisible();
        await expect(triggers.locator('.wb-tok')).toHaveText('Any of');
        expect((await storedEntry(page, name, 2)).keysecondary).toEqual(['harbour', 'quay']);

        await triggers.getByLabel('“harbour”, secondary trigger', { exact: true }).click();
        await triggers.getByRole('textbox', { name: 'Edit “harbour”' }).fill('port');
        await page.keyboard.press('Enter');
        await expect(triggers.getByLabel('“port”, secondary trigger', { exact: true })).toBeVisible();
        expect((await storedEntry(page, name, 2)).keysecondary).toEqual(['port', 'quay']);

        await triggers.getByLabel('“quay”, secondary trigger', { exact: true }).click();
        await pane(page).locator('.wb-pop').getByRole('button', { name: 'Remove' }).click();
        await expect(triggers.getByLabel('“quay”, secondary trigger', { exact: true })).toHaveCount(0);
        expect((await storedEntry(page, name, 2)).keysecondary).toEqual(['port']);
        await deleteWorld(page, name);
    });

    test('keys already in the world are suggested, with how many entries have each, while one is typed', async ({ page }) => {
        const name = unique('Suggest');
        await makeWorld(page, name, { ...COAST, 4: entry(4, 'Ledger Hall', ['ledger'], 'Where ledgers are kept.') }, { relationKinds: [{ id: 1, name: 'in' }] });
        await openEntry(page, 'The Tidegate');
        const triggers = pane(page).locator('.wb-triggers');
        await triggers.getByRole('button', { name: 'Add trigger' }).click();
        await triggers.getByRole('textbox', { name: 'Trigger' }).fill('led');
        const option = pane(page).getByRole('option', { name: /ledger/ });
        await expect(option).toContainText('2 entries');
        await option.click();
        await expect(triggers.getByLabel('“ledger”, trigger', { exact: true })).toBeVisible();
        expect((await storedEntry(page, name, 3)).key).toEqual(['The Tidegate', 'ledger']);
        await deleteWorld(page, name);
    });

    test('a relation is added from the entry\'s page, and the entry shows under its target', async ({ page }) => {
        const name = unique('Relations');
        await openCoast(page, name);
        await openEntry(page, 'The Tidegate');
        await pane(page).locator('.wb-rels-add').click();
        const asked = pane(page).getByRole('dialog', { name: 'New relation' });
        await asked.getByRole('tab', { name: 'in', exact: true }).click();
        await asked.getByLabel('Search entries').fill('Lantern');
        await asked.getByRole('option', { name: /The Lantern House/ }).click();
        await expect(pane(page).locator('.wb-rels')).toContainText('in:The Lantern House');
        await pane(page).locator('.wb-rel-target', { hasText: 'The Lantern House' }).click();
        await expect(pane(page).locator('.wb-entry .wb-entry-name')).toContainText('The Lantern House');
        await expect(pane(page).locator('.wb-section', { hasText: 'in → The Lantern House' }).locator('.wb-card', { hasText: 'The Tidegate' })).toBeVisible();
        await deleteWorld(page, name);
    });

    test('new entries: from the header at the world\'s end, and from "+ New entry" under an entry with that relation', async ({ page }) => {
        const name = unique('New');
        await openCoast(page, name);
        await pane(page).getByRole('button', { name: 'New entry' }).click();
        await expect(pane(page).locator('.wb-entry .wb-entry-name')).toContainText('Title');
        await pane(page).getByRole('button', { name: 'Title' }).click();
        await page.keyboard.type('Season of fog');
        await page.keyboard.press('Enter');
        await expect(pane(page).locator('.wb-entry .wb-entry-name')).toContainText('Season of fog');
        await pane(page).locator('.wb-rels-world').click();
        await expect(pane(page).locator('.wb-front-meta')).toContainText('5 entries');

        await openEntry(page, 'The Lantern House');
        await expect(pane(page).locator('.wb-new-under')).toContainText('in → The Lantern House');
        await page.mouse.move(2, 400);
        await pane(page).locator('.wb-new-under').click();
        await expect(pane(page).locator('.wb-rels')).toContainText('in:The Lantern House');
        await deleteWorld(page, name);
    });

    test('an entry deleted from its menu can be restored', async ({ page }) => {
        const name = unique('Delete');
        await openCoast(page, name);
        await openEntry(page, 'The Tidegate');
        await pane(page).getByRole('button', { name: 'More' }).click();
        await pane(page).getByRole('menuitem', { name: 'Delete', exact: true }).click();
        const said = pane(page).locator('.wb-offer', { hasText: 'Deleted' });
        await expect(said).toContainText('The Tidegate');
        await expect(pane(page).locator('.wb-front-meta')).toContainText('3 entries');
        await said.getByRole('button', { name: 'Restore' }).click();
        await expect(pane(page).locator('.wb-front-meta')).toContainText('4 entries');
        await expect(pane(page).locator('.wb-card', { hasText: 'The Tidegate' })).toBeVisible();
        await deleteWorld(page, name);
    });

    test('where an entry goes in the prompt is changed from its "Entry settings" sentence', async ({ page }) => {
        const name = unique('Prompt');
        await openCoast(page, name);
        await openEntry(page, 'Ilse Varro');
        const button = pane(page).getByRole('button', { name: 'Entry settings' });
        await expect(button.locator('.wb-dot')).toHaveCount(0);
        await button.click();
        const sentence = pane(page).getByRole('dialog', { name: 'Entry settings' });
        await expect(sentence).toContainText('tokens');
        await sentence.getByRole('button', { name: 'Before character' }).click();
        await sentence.getByRole('option', { name: 'After character' }).click();
        await expect(sentence).toContainText('Position: After character');
        await page.keyboard.press('Escape');
        await expect(button.locator('.wb-dot')).toHaveCount(1);
        const stored = await page.evaluate(async (name) => {
            const { getRequestHeaders } = await import('/scripts/request-headers.js');
            const read = await fetch('/api/worldinfo/entry/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name, uid: 2 }) });
            return (await read.json()).entry.position;
        }, name);
        expect(stored).toBe(1);
        await deleteWorld(page, name);
    });

    test('an imported book offers to mark the keys that are titles as names, and the marking can be undone', async ({ page }) => {
        const name = unique('Imported');
        await makeWorld(page, name, {
            0: entry(0, 'Gerold Venn', ['Gerold Venn', 'miller'], 'The miller.'),
            1: entry(1, 'Rhea', ['Rhea'], 'A hunter.'),
        });
        await openWorld(page, name);
        const offer = pane(page).locator('.wb-offer');
        await expect(offer).toContainText('In 2 entries, a key is the title');
        await offer.getByRole('button', { name: 'Mark as name keys' }).click();
        await expect(offer).toContainText('Marked as name keys.');
        await openEntry(page, 'Rhea');
        await expect(pane(page).locator('.wb-names').getByLabel('“Rhea”, name', { exact: true })).toBeVisible();
        await pane(page).locator('.wb-rels-world').click();
        await pane(page).locator('.wb-offer').getByRole('button', { name: 'Undo' }).click();
        await expect(pane(page).locator('.wb-offer')).toContainText('a key is the title');
        await deleteWorld(page, name);
    });

    test('the world switcher switches worlds, makes one, imports one and deletes one', async ({ page }) => {
        const first = unique('First');
        const made = unique('Made');
        const imported = unique('Imported file');
        await openCoast(page, first);
        await pane(page).getByRole('button', { name: 'Switch world' }).click();
        await pane(page).getByRole('menuitem', { name: 'New world…' }).click();
        await page.locator('dialog[open] .popup-input').fill(made);
        await page.locator('dialog[open] .popup-button-ok').click();
        await expect(pane(page).locator('h1.wb-front-name')).toHaveText(made);

        await pane(page).getByRole('button', { name: 'Switch world' }).click();
        const chooser = page.waitForEvent('filechooser');
        await pane(page).getByRole('menuitem', { name: 'Import world…' }).click();
        await (await chooser).setFiles({ name: `${imported}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ entries: { 0: entry(0, 'Brother Hallam', ['Hallam'], 'A priest.') } })) });
        await expect(pane(page).locator('h1.wb-front-name')).toHaveText(imported);
        await expect(pane(page).locator('.wb-card', { hasText: 'Brother Hallam' })).toBeVisible();

        await pane(page).getByRole('button', { name: 'Switch world' }).click();
        await pane(page).getByRole('menuitem', { name: new RegExp(first) }).click();
        await expect(pane(page).locator('h1.wb-front-name')).toHaveText(first);

        for (const name of [made, imported, first]) await deleteWorld(page, name);
    });
});
