import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { startLlamaCpp, connectLlamaCpp, openCharacter } from './llamacpp-mock.js';
import { PARITY_CASES, applyChatMetadata, applyPowerUser } from './prompt-parity-cases.js';

// The prompt sent for a chat is the prompt upstream builds for it: upstream's page built each case's prompt
// (tests/prompt-goldens.mjs, kept in prompt-goldens/), and both the server's (what a backend is sent) and this page's
// own (a dry run of Generate()) must be the same. Any difference is a bug.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const goldens = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompt-goldens');

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
 * @param {Record<string, string>} card Create form fields.
 */
async function openCard(page, card) {
    const avatar = await page.evaluate(async (card) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const form = new FormData();
        for (const [key, value] of Object.entries(card)) form.set(key, value);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        return (await response.text()).trim();
    }, card);
    await openCharacter(page, avatar);
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
 * The prompt this page builds for a generation of `type` now, without sending it.
 * @param {import('@playwright/test').Page} page
 * @param {string} type
 * @returns {Promise<string>}
 */
async function pagePrompt(page, type) {
    return page.evaluate(async (type) => {
        // @ts-ignore
        const { eventSource, eventTypes } = SillyTavern.getContext();
        const { Generate } = await import('/script.js');
        // The combined text completion prompt, as both upstream's and this page's Generate() give it.
        let prompt = '';
        const take = (/** @type {{ prompt: string, dryRun: boolean }} */ data) => { if (data.dryRun) prompt = data.prompt; };
        eventSource.on(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, take);
        try {
            await Generate(type, {}, true);
        } finally {
            eventSource.removeListener(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, take);
        }
        return String(prompt);
    }, type);
}

/** The slash command that sends a generation of each type the server builds. */
const SEND = { normal: '/trigger', continue: '/continue', impersonate: '/impersonate' };

/**
 * The prompt the server builds for the same generation, as the backend gets it.
 * @param {import('@playwright/test').Page} page
 * @param {string} type
 * @returns {Promise<string>}
 */
async function serverPrompt(page, type) {
    const completions = () => llama.log.filter(entry => entry.url.startsWith('/completion'));
    const before = completions().length;
    await slash(page, SEND[type]);
    await expect.poll(() => completions().length, { timeout: 20000 }).toBeGreaterThan(before);
    return String(completions()[before].body.prompt);
}

test.describe('text completion', () => {
    for (const parityCase of PARITY_CASES) {
        test(`${parityCase.name}`, async ({ page }) => {
            const expected = fs.readFileSync(path.join(goldens, `${parityCase.name}.txt`), 'utf8');
            await connectLlamaCpp(page, llama.url);
            await openCard(page, parityCase.card);
            if (parityCase.powerUser) {
                await page.evaluate(applyPowerUser, parityCase.powerUser);
                await page.evaluate(async () => {
                    const { saveSettings } = await import('/script.js');
                    await saveSettings();
                });
            }
            for (const step of parityCase.steps) await slash(page, step);
            if (parityCase.chatMetadata) await page.evaluate(applyChatMetadata, parityCase.chatMetadata);
            const type = parityCase.type ?? 'normal';
            expect.soft(await pagePrompt(page, type), 'the page\'s own prompt').toBe(expected);
            expect.soft(await serverPrompt(page, type), 'the server\'s prompt').toBe(expected);
        });
    }
});
