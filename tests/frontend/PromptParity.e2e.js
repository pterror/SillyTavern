import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { startLlamaCpp, connectLlamaCpp, openCharacter } from './llamacpp-mock.js';

// The prompt the server builds is the prompt the page builds for the same chat: the page's builder (a dry run of
// Generate(), which never takes the server's path) is the reference, the server's is what a backend is sent. Any
// difference is a bug in the server's.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @type {Awaited<ReturnType<typeof startLlamaCpp>>} */
let llama;

test.beforeEach(async ({ page }) => {
    llama = await startLlamaCpp();
    await testSetup.awaitST({ page });
});

test.afterEach(async () => {
    await llama.close();
});

/**
 * Makes a character from card fields and opens its chat.
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, string>} fields Create form fields (`ch_name` is made unique).
 */
async function openCard(page, fields) {
    const avatar = await page.evaluate(async (fields) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.set(key, value);
        form.set('ch_name', `${fields.ch_name ?? 'Parity'} ${Date.now()}`);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        return (await response.text()).trim();
    }, fields);
    await openCharacter(page, avatar);
    return avatar;
}

/**
 * Runs slash commands as typed.
 * @param {import('@playwright/test').Page} page
 * @param {string} commands
 */
async function slash(page, commands) {
    await page.evaluate(async (commands) => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions(commands);
    }, commands);
}

/**
 * The prompt the page builds for a generation of `type` now, without sending it.
 * @param {import('@playwright/test').Page} page
 * @param {string} [type]
 * @returns {Promise<string>}
 */
async function pagePrompt(page, type = 'normal') {
    return page.evaluate(async (type) => {
        // @ts-ignore
        const { eventSource, eventTypes } = SillyTavern.getContext();
        const { Generate } = await import('/script.js');
        let data = null;
        const take = (/** @type {any} */ generateData, /** @type {boolean} */ dryRun) => { if (dryRun) data = generateData; };
        eventSource.on(eventTypes.GENERATE_AFTER_DATA, take);
        try {
            await Generate(type, {}, true);
        } finally {
            eventSource.removeListener(eventTypes.GENERATE_AFTER_DATA, take);
        }
        return String(data?.prompt ?? '');
    }, type);
}

/**
 * The prompt the server builds for the same generation, as the backend gets it.
 * @param {import('@playwright/test').Page} page
 * @param {string} command The slash command that generates (`/trigger`, `/continue`, …).
 * @returns {Promise<string>}
 */
async function serverPrompt(page, command = '/trigger') {
    const before = llama.log.filter(entry => entry.url.startsWith('/completion')).length;
    await slash(page, command);
    await expect.poll(() => llama.log.filter(entry => entry.url.startsWith('/completion')).length, { timeout: 20000 }).toBeGreaterThan(before);
    return String(llama.log.filter(entry => entry.url.startsWith('/completion'))[before].body.prompt);
}

test.describe('text completion', () => {
    test('a plain character chat', async ({ page }) => {
        await connectLlamaCpp(page, llama.url);
        await openCard(page, {
            ch_name: 'Parity plain',
            first_mes: 'Hello, traveller.',
            description: 'A quiet innkeeper.',
            personality: 'Patient.',
            scenario: 'A rainy evening at the inn.',
            mes_example: '<START>\n{{user}}: Hi.\n{{char}}: Welcome.',
        });
        await slash(page, '/send I would like a room.');
        const expected = await pagePrompt(page);
        expect(expected).toContain('A quiet innkeeper.');
        expect(await serverPrompt(page)).toBe(expected);
    });
});
