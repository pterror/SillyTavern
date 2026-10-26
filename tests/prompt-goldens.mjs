// Records upstream's prompt for each prompt parity case (frontend/prompt-parity-cases.js) into frontend/prompt-goldens/:
// upstream's page builds it (a dry run of Generate()), from a fresh upstream server.
//
// Usage: node prompt-goldens.mjs <upstream URL>, with an upstream SillyTavern (the `release` branch) running there on
// its own data root. Every case's character is created in it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { PARITY_CASES, applyChatMetadata, applyPowerUser } from './frontend/prompt-parity-cases.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'frontend', 'prompt-goldens');
const url = process.argv[2];
if (!url) {
    console.error('Usage: node prompt-goldens.mjs <upstream URL>');
    process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {});
try {
    for (const parityCase of PARITY_CASES) {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 60000 });
        // A text completion backend's prompt (llama.cpp's), as the parity test connects to.
        await page.evaluate(() => {
            $('#main_api').val('textgenerationwebui').trigger('change');
            $('#textgen_type').val('llamacpp').trigger('change');
        });
        await page.evaluate(async (card) => {
            // @ts-ignore
            const context = SillyTavern.getContext();
            const form = new FormData();
            for (const [key, value] of Object.entries(card)) form.set(key, value);
            // Upstream's getRequestHeaders() always says JSON: the form goes with its CSRF token alone.
            const headers = { 'X-CSRF-Token': context.getRequestHeaders()['X-CSRF-Token'] };
            const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
            const avatar = (await response.text()).trim();
            await context.getCharacters();
            const index = context.characters.findIndex(c => c.avatar === avatar);
            await context.selectCharacterById(index);
        }, parityCase.card);
        await page.waitForFunction(() => document.querySelector('#chat .mes[mesid="0"]') !== null, null, { timeout: 30000 });
        if (parityCase.powerUser) await page.evaluate(applyPowerUser, parityCase.powerUser);
        for (const step of parityCase.steps) {
            await page.evaluate(async (step) => {
                // @ts-ignore
                await SillyTavern.getContext().executeSlashCommandsWithOptions(step);
            }, step);
        }
        if (parityCase.chatMetadata) await page.evaluate(applyChatMetadata, parityCase.chatMetadata);
        const prompt = await page.evaluate(async (type) => {
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
        }, parityCase.type ?? 'normal');
        if (!prompt) throw new Error(`${parityCase.name}: upstream built no prompt`);
        fs.writeFileSync(path.join(out, `${parityCase.name}.txt`), prompt);
        console.log(`${parityCase.name}: ${prompt.length} characters`);
        await page.close();
    }
} finally {
    await browser.close();
}
