import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { startLlamaCpp, connectLlamaCpp, openCharacter } from './llamacpp-mock.js';
import { startOpenAICompat, connectOpenAICompat } from './openai-mock.js';
import { PARITY_CASES, applyChatMetadata, applyPersona, applyPowerUser, createLorebook } from './prompt-parity-cases.js';

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

/** @type {Record<string, unknown> | null} The settings the case replaced. */
let restore = null;
/** Whether the case gave the persona a description, to clear once it's done. */
let clearPersona = false;

test.afterEach(async ({ page }) => {
    await llama.close();
    if (restore) {
        await page.evaluate(applyPowerUser, restore);
        await saveSettings(page);
        restore = null;
    }
    if (clearPersona) {
        await page.evaluate(applyPersona, { description: '', position: 0 });
        await saveSettings(page);
        clearPersona = false;
    }
});

/** @param {import('@playwright/test').Page} page */
async function saveSettings(page) {
    await page.evaluate(async () => {
        const { saveSettings } = await import('/script.js');
        await saveSettings();
    });
}

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

/**
 * Sets a case's chat up, after the connection: its lorebook and character, its settings, its messages, its metadata and
 * its persona.
 * @param {import('@playwright/test').Page} page
 * @param {import('./prompt-parity-cases.js').ParityCase} parityCase
 */
async function setUp(page, parityCase) {
    if (parityCase.lorebook) await page.evaluate(createLorebook, parityCase.lorebook);
    await openCard(page, parityCase.card);
    if (parityCase.powerUser) {
        // Put back once the case is done: the cases in a worker share its server's settings.
        restore = await page.evaluate(applyPowerUser, parityCase.powerUser);
        await saveSettings(page);
    }
    for (const step of parityCase.steps) await slash(page, step);
    if (parityCase.chatMetadata) await page.evaluate(applyChatMetadata, parityCase.chatMetadata);
    if (parityCase.persona) {
        clearPersona = true;
        await page.evaluate(applyPersona, parityCase.persona);
        await saveSettings(page);
    }
}

test.describe('text completion', () => {
    for (const parityCase of PARITY_CASES.filter(c => c.name.startsWith('tc-'))) {
        test(`${parityCase.name}`, async ({ page }) => {
            const expected = fs.readFileSync(path.join(goldens, `${parityCase.name}.txt`), 'utf8');
            await connectLlamaCpp(page, llama.url);
            await setUp(page, parityCase);
            const type = parityCase.type ?? 'normal';
            expect.soft(await pagePrompt(page, type), 'the page\'s own prompt').toBe(expected);
            expect.soft(await serverPrompt(page, type), 'the server\'s prompt').toBe(expected);
        });
    }
});

test.describe('chat completion', () => {
    /** @type {Awaited<ReturnType<typeof startOpenAICompat>>} */
    let openai;

    test.beforeEach(async () => {
        openai = await startOpenAICompat();
    });

    test.afterEach(async () => {
        await openai.close();
    });

    // What upstream's server sends: the messages, after its own processing of them.
    for (const parityCase of PARITY_CASES.filter(c => c.name.startsWith('cc-'))) {
        test(`${parityCase.name}`, async ({ page }) => {
            const expected = JSON.parse(fs.readFileSync(path.join(goldens, `${parityCase.name}.json`), 'utf8'));
            await connectOpenAICompat(page, openai.url);
            await setUp(page, parityCase);
            const sends = () => openai.log.filter(entry => entry.url.endsWith('/chat/completions'));
            const before = sends().length;
            await slash(page, SEND[parityCase.type ?? 'normal']);
            await expect.poll(() => sends().length, { timeout: 20000 }).toBeGreaterThan(before);
            expect(sends()[before].body.messages).toEqual(expected);
        });
    }
});
