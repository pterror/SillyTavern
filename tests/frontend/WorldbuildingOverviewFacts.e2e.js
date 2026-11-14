import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { openWorld } from './worlds.js';

const NAME = 'Big World';
const COUNT = 300;

// An upstream world file with a realistic mix: some off, some always in, some with secondary keys, some into the chat.
const entries = Object.fromEntries(Array.from({ length: COUNT }, (_, i) => [i, {
    uid: i,
    key: [`thing${i}`, `alias${i}`],
    keysecondary: i % 7 === 0 && i > 0 ? [`also${i}`] : [],
    comment: `Entry ${i}`,
    content: `Entry ${i} is about thing ${i}.`,
    constant: i % 25 === 0,
    selective: true,
    selectiveLogic: i % 7 === 0 ? 2 : 0,
    order: 100,
    position: i % 11 === 0 ? 4 : 0,
    depth: 4,
    disable: i % 8 === 3,
    probability: 100,
    useProbability: true,
    displayIndex: i,
}]));
const OFF = Object.values(entries).filter(entry => entry.disable).length;

test.use({ freshAccount: true, upstreamFiles: { [`worlds/${NAME}.json`]: JSON.stringify({ entries }) } });

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding');
const card = (/** @type {import('@playwright/test').Page} */ page, /** @type {number} */ i) =>
    pane(page).locator('.wb-card', { has: page.locator('.wb-card-name', { hasText: new RegExp(`^Entry ${i}$`) }) });

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} uid
 */
async function storedEntry(page, uid) {
    return page.evaluate(async (uid) => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const read = await fetch('/api/worldinfo/entry/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: 'Big World', uid }) });
        return (await read.json()).entry;
    }, uid);
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

test.describe('a world of hundreds of entries, on its page', () => {
    test.beforeEach(async ({ page }) => {
        // The account is the worker's: only its first page shows the onboarding.
        await page.goto('/');
        const onboarding = page.locator('dialog[open] .onboarding');
        if (await onboarding.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
            await testSetup.awaitFreshST({ page });
        } else {
            await testSetup.awaitST({ page });
        }
        await openWorld(page, NAME);
    });

    test('the count is every entry, the ones off included', async ({ page }) => {
        expect(OFF).toBeGreaterThan(30);
        await expect(pane(page).locator('.wb-front-meta')).toContainText(`${COUNT} entries`);
    });

    test('a card shows what brings its entry up and where it goes, and is switched on and off in one action', async ({ page }) => {
        await expect(card(page, 0).locator('.wb-card-triggers')).toHaveText('Constant');
        await expect(card(page, 0).locator('.wb-card-goes')).toHaveText('At depth 4');
        await expect(card(page, 1).locator('.wb-card-triggers .wb-key')).toHaveText(['thing1', 'alias1']);
        await expect(card(page, 7).locator('.wb-card-triggers')).toContainText('+ none of');
        await expect(card(page, 7).locator('.wb-card-triggers .wb-key')).toHaveText(['thing7', 'alias7', 'also7']);
        await expect(card(page, 3).locator('.wb-onoff')).toHaveAttribute('aria-checked', 'false');

        const sent = await actionsDuring(page, 'worldbuilding.setPlacement', async () => {
            await card(page, 3).locator('.wb-onoff').click();
            await expect(card(page, 3).locator('.wb-onoff')).toHaveAttribute('aria-checked', 'true');
        });
        expect(sent).toBe(1);
        expect((await storedEntry(page, 3)).disable).toBe(false);
        await card(page, 4).locator('.wb-onoff').click();
        await expect(card(page, 4)).toHaveClass(/wb-card-off/);
        await expect.poll(async () => (await storedEntry(page, 4)).disable).toBe(true);
    });

    test('a card\'s keys are edited in place without opening the entry: edit, add several, remove, and a secondary key', async ({ page }) => {
        const keys = card(page, 1).locator('.wb-card-triggers');
        const renamed = await actionsDuring(page, 'worldbuilding.renameKey', async () => {
            await keys.getByLabel('“thing1”, trigger', { exact: true }).click();
            await expect(keys.getByRole('textbox', { name: 'Edit “thing1”' })).toHaveValue('thing1');
            await keys.getByRole('textbox', { name: 'Edit “thing1”' }).fill('thing one');
            await page.keyboard.press('Enter');
            await expect(keys.getByLabel('“thing one”, trigger', { exact: true })).toBeVisible();
        });
        expect(renamed).toBe(1);
        await expect(pane(page).locator('.wb-entry')).toHaveCount(0);
        expect((await storedEntry(page, 1)).key).toEqual(['thing one', 'alias1']);

        const added = await actionsDuring(page, 'worldbuilding.addKeys', async () => {
            await keys.getByRole('button', { name: 'Add trigger' }).click();
            await keys.getByRole('textbox', { name: 'Trigger' }).fill('x, y');
            await page.keyboard.press('Enter');
            await expect(keys.getByLabel('“y”, trigger', { exact: true })).toBeVisible();
        });
        expect(added).toBe(1);
        expect((await storedEntry(page, 1)).key).toEqual(['thing one', 'alias1', 'x', 'y']);

        await keys.getByLabel('“x”, trigger', { exact: true }).click();
        await pane(page).locator('.wb-pop').getByRole('button', { name: 'Remove' }).click();
        await expect(keys.getByLabel('“x”, trigger', { exact: true })).toHaveCount(0);
        expect((await storedEntry(page, 1)).key).toEqual(['thing one', 'alias1', 'y']);

        const secondary = card(page, 7).locator('.wb-card-triggers');
        await secondary.getByLabel('“also7”, secondary trigger', { exact: true }).click();
        await secondary.getByRole('textbox', { name: 'Edit “also7”' }).fill('also seven');
        await page.keyboard.press('Enter');
        await expect(secondary.getByLabel('“also seven”, secondary trigger', { exact: true })).toBeVisible();
        expect((await storedEntry(page, 7)).keysecondary).toEqual(['also seven']);
        await expect(pane(page).locator('.wb-entry')).toHaveCount(0);
    });

    test('a card shows an entry\'s keys without its names', async ({ page }) => {
        await card(page, 2).locator('.wb-card-open').click();
        await pane(page).locator('.wb-names').getByRole('button', { name: 'Add name' }).click();
        await pane(page).locator('.wb-names').getByRole('textbox', { name: 'Name' }).fill('Second');
        await page.keyboard.press('Enter');
        await expect(pane(page).locator('.wb-names').getByLabel('“Second”, name', { exact: true })).toBeVisible();
        await pane(page).locator('.wb-rels-world').click();
        await expect(card(page, 2).locator('.wb-card-triggers .wb-key')).toHaveText(['thing2', 'alias2']);
    });

    test('pointing at a card shows its hover card', async ({ page }) => {
        await card(page, 5).hover();
        const hover = pane(page).locator('.wb-hover');
        await expect(hover).toBeVisible();
        await expect(hover.locator('.wb-hover-name')).toHaveText('Entry 5');
        await page.mouse.move(2, 400);
        await expect(hover).toHaveCount(0);
    });

    test('a row switches its entry on and off in one action', async ({ page }) => {
        await pane(page).getByRole('button', { name: '+ View' }).click();
        await pane(page).locator('.wb-vseg label').nth(1).click();
        const row = pane(page).locator('.wb-tr[data-entry]', { hasText: /^Entry 11(?!\d)/ });
        await expect(row.locator('.wb-onoff')).toHaveAttribute('aria-checked', 'false');
        const sent = await actionsDuring(page, 'worldbuilding.setPlacement', async () => {
            await row.locator('.wb-onoff').click();
            await expect(row.locator('.wb-onoff')).toHaveAttribute('aria-checked', 'true');
        });
        expect(sent).toBe(1);
        expect((await storedEntry(page, 11)).disable).toBe(false);
    });

    test('a row\'s Names and Triggers columns are edited in place the same way', async ({ page }) => {
        await pane(page).getByRole('button', { name: '+ View' }).click();
        await pane(page).locator('.wb-vseg label').nth(1).click();
        const row = pane(page).locator('.wb-tr[data-entry]', { hasText: /^Entry 12(?!\d)/ });
        await expect(pane(page).locator('.wb-th')).toContainText('Names');
        await expect(pane(page).locator('.wb-th')).toContainText('Triggers');
        const triggers = row.locator('.wb-row-keys').nth(1);
        await triggers.getByLabel('“alias12”, trigger', { exact: true }).click();
        await triggers.getByRole('textbox', { name: 'Edit “alias12”' }).fill('twelve');
        await page.keyboard.press('Enter');
        await expect(triggers.getByLabel('“twelve”, trigger', { exact: true })).toBeVisible();
        expect((await storedEntry(page, 12)).key).toEqual(['thing12', 'twelve']);

        const names = row.locator('.wb-row-keys').first();
        await names.getByRole('button', { name: 'Add name' }).click();
        await names.getByRole('textbox', { name: 'Name' }).fill('Twelve');
        await page.keyboard.press('Enter');
        await expect(names.getByLabel('“Twelve”, name', { exact: true })).toBeVisible();
        await expect(triggers.getByLabel('“Twelve”, trigger', { exact: true })).toHaveCount(0);
        const stored = await storedEntry(page, 12);
        expect(stored.key).toEqual(['thing12', 'twelve', 'Twelve']);
        expect(stored.extensions.names).toEqual(['Twelve']);
    });

    test('every placement field the old editor had is set from the entry\'s "Entry settings" sentence', async ({ page }) => {
        await card(page, 7).locator('.wb-card-open').click();
        await pane(page).locator('.wb-triggers .wb-tok').click();
        await pane(page).getByRole('option', { name: 'All of', exact: true }).click();
        await expect.poll(async () => (await storedEntry(page, 7)).selectiveLogic).toBe(3);
        await expect(pane(page).locator('.wb-triggers .wb-tok')).toHaveText('All of');
        await pane(page).getByRole('button', { name: 'Entry settings' }).click();
        const sentence = pane(page).getByRole('dialog', { name: 'Entry settings' });
        const more = async (/** @type {string} */ offer) => {
            await sentence.getByRole('button', { name: '+ More' }).click();
            await expect(sentence.locator('.wb-choice', { hasText: 'Secondary' })).toHaveCount(0);
            await sentence.locator('.wb-choice', { hasText: offer }).click();
        };

        await sentence.getByRole('button', { name: 'Before character' }).click();
        await sentence.getByRole('option', { name: 'At depth' }).click();
        await sentence.getByRole('button', { name: 'System' }).click();
        await sentence.getByRole('option', { name: 'Assistant' }).click();
        await expect.poll(async () => (await storedEntry(page, 7))).toMatchObject({ position: 4, role: 2 });

        await more('Non-recursable');
        await expect.poll(async () => (await storedEntry(page, 7)).excludeRecursion).toBe(true);
        await expect(sentence).toContainText('Non-recursable');

        await more('Group weight');
        await sentence.getByRole('textbox', { name: 'Group weight' }).fill('250');
        await page.keyboard.press('Enter');
        await expect.poll(async () => (await storedEntry(page, 7)).groupWeight).toBe(250);

        await more('Additional matching sources');
        await sentence.getByRole('option', { name: 'Scenario' }).click();
        await expect.poll(async () => (await storedEntry(page, 7)).matchScenario).toBe(true);

        await more('Generation triggers');
        await sentence.getByRole('option', { name: 'Swipe' }).click();
        await expect.poll(async () => (await storedEntry(page, 7)).triggers).toEqual(['swipe']);

        await sentence.getByRole('button', { name: 'Remove Non-recursable' }).click();
        await expect.poll(async () => (await storedEntry(page, 7)).excludeRecursion).toBe(false);
    });
});
