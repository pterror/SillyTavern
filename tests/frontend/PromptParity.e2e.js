import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { startLlamaCpp, connectLlamaCpp, openCharacter } from './llamacpp-mock.js';
import { startOpenAICompat, connectOpenAICompat } from './openai-mock.js';
import { PARITY_CASES, applyChatMetadata, applyPersona, applyPowerUser, createLorebook } from './prompt-parity-cases.js';

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

/** @type {Record<string, unknown> | null} */
let restore = null;
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
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, string>} card
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
 * @param {import('@playwright/test').Page} page
 * @param {string} type
 * @returns {Promise<string>}
 */
async function pagePrompt(page, type) {
    return page.evaluate(async (type) => {
        // @ts-ignore
        const { eventSource, eventTypes } = SillyTavern.getContext();
        const { Generate } = await import('/script.js');
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

const SEND = { normal: '/trigger', continue: '/continue', impersonate: '/impersonate' };

/**
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
 * @param {import('@playwright/test').Page} page
 * @param {import('./prompt-parity-cases.js').ParityCase} parityCase
 */
async function setUp(page, parityCase) {
    if (parityCase.lorebook) await page.evaluate(createLorebook, parityCase.lorebook);
    await openCard(page, parityCase.card);
    if (parityCase.powerUser) {
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
