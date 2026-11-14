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
        await expect(card(page, 0).locator('.wb-card-triggers')).toHaveText('Always');
        await expect(card(page, 0).locator('.wb-card-goes')).toHaveText('Into the chat, 4 up');
        await expect(card(page, 1).locator('.wb-card-triggers')).toHaveText('thing1, alias1');
        await expect(card(page, 7).locator('.wb-card-triggers')).toHaveText('thing7, alias7 + none of also7');
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

    test('every placement field the old editor had is set from the entry\'s "In the prompt" sentence', async ({ page }) => {
        await card(page, 7).locator('.wb-card-open').click();
        await pane(page).getByRole('button', { name: 'In the prompt' }).click();
        const sentence = pane(page).getByRole('dialog', { name: 'In the prompt' });
        const more = async (/** @type {string} */ offer) => {
            await sentence.getByRole('button', { name: '+ More' }).click();
            await sentence.locator('.wb-choice', { hasText: offer }).click();
        };

        await sentence.getByRole('button', { name: 'none of' }).click();
        await sentence.getByRole('option', { name: 'all of', exact: true }).click();
        await expect.poll(async () => (await storedEntry(page, 7)).selectiveLogic).toBe(3);

        await sentence.getByRole('button', { name: 'before the character’s description' }).click();
        await sentence.getByRole('option', { name: 'into the chat' }).click();
        await sentence.getByRole('button', { name: 'the system' }).click();
        await sentence.getByRole('option', { name: 'the assistant' }).click();
        await expect.poll(async () => (await storedEntry(page, 7))).toMatchObject({ position: 4, role: 2 });

        await more('Isn’t brought up by other entries’ text');
        await expect.poll(async () => (await storedEntry(page, 7)).excludeRecursion).toBe(true);
        await expect(sentence).toContainText('Other entries’ text doesn’t bring it up.');

        await more('Is more or less likely to be its group’s pick');
        await sentence.getByRole('textbox', { name: 'Is more or less likely to be its group’s pick' }).fill('250');
        await page.keyboard.press('Enter');
        await expect.poll(async () => (await storedEntry(page, 7)).groupWeight).toBe(250);

        await more('Looks for its keys outside the chat too');
        await sentence.getByRole('option', { name: 'the scenario' }).click();
        await expect.poll(async () => (await storedEntry(page, 7)).matchScenario).toBe(true);

        await more('Comes in only for some kinds of reply');
        await sentence.getByRole('option', { name: 'swipes' }).click();
        await expect.poll(async () => (await storedEntry(page, 7)).triggers).toEqual(['swipe']);

        await sentence.getByRole('button', { name: 'Take away: Isn’t brought up by other entries’ text' }).click();
        await expect.poll(async () => (await storedEntry(page, 7)).excludeRecursion).toBe(false);
    });
});
