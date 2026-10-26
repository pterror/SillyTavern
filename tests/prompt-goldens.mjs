// Records upstream's prompt for each prompt parity case (frontend/prompt-parity-cases.js) into frontend/prompt-goldens/.
// A text completion case's is the prompt upstream's page builds (a dry run of Generate()); a chat completion case's is
// the messages upstream's server sends, to a mock OpenAI-compatible backend, as JSON.
//
// Usage: node prompt-goldens.mjs <upstream URL> [case name filter], with an upstream SillyTavern at the commit the fork
// tracks running there on its own data root. Every case's character is created in it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { PARITY_CASES, applyChatMetadata, applyPersona, applyPowerUser, createLorebook } from './frontend/prompt-parity-cases.js';
import { startOpenAICompat } from './frontend/openai-mock-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'frontend', 'prompt-goldens');
const url = process.argv[2];
if (!url) {
    console.error('Usage: node prompt-goldens.mjs <upstream URL>');
    process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

/** The slash command that sends a generation of each type. */
const SEND = { normal: '/trigger', continue: '/continue', impersonate: '/impersonate' };

const only = process.argv[3] ?? '';
const openai = await startOpenAICompat();
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {});
try {
    for (const parityCase of PARITY_CASES.filter(c => c.name.includes(only))) {
        const chatCompletion = parityCase.name.startsWith('cc-');
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 60000 });
        // A fresh upstream asks for a language and a persona name first, and finishes starting once they're given:
        // the defaults (English, "User"), as the parity test's server has them.
        const welcome = page.locator('dialog[open] .popup-button-ok').first();
        if (await welcome.waitFor({ timeout: 10000 }).then(() => true, () => false)) await welcome.click();
        await page.waitForFunction(() => !!$._data(document.getElementById('persona_description'), 'events'), null, { timeout: 60000 });
        if (chatCompletion) {
            // The custom source at the mock, as the parity test connects to.
            await page.evaluate(async (url) => {
                const set = (/** @type {string} */ id, /** @type {string} */ value, /** @type {string} */ event) => {
                    const element = /** @type {HTMLInputElement} */ (document.getElementById(id));
                    element.value = value;
                    element.dispatchEvent(new Event(event, { bubbles: true }));
                };
                set('main_api', 'openai', 'change');
                set('chat_completion_source', 'custom', 'change');
                set('custom_api_url_text', url, 'input');
                set('custom_model_id', 'mock-chat-model', 'input');
                document.getElementById('api_button_openai').click();
            }, openai.url);
            await page.waitForFunction(() => SillyTavern.getContext().onlineStatus !== 'no_connection', null, { timeout: 30000 });
        } else {
            // A text completion backend's prompt (llama.cpp's), as the parity test connects to.
            await page.evaluate(() => {
                $('#main_api').val('textgenerationwebui').trigger('change');
                $('#textgen_type').val('llamacpp').trigger('change');
            });
        }
        if (parityCase.lorebook) await page.evaluate(createLorebook, parityCase.lorebook);
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
        if (parityCase.persona) await page.evaluate(applyPersona, parityCase.persona);
        if (chatCompletion) {
            const before = openai.log.filter(entry => entry.url.endsWith('/chat/completions')).length;
            await page.evaluate(async (command) => {
                // @ts-ignore
                await SillyTavern.getContext().executeSlashCommandsWithOptions(command);
            }, SEND[parityCase.type ?? 'normal']);
            const sends = () => openai.log.filter(entry => entry.url.endsWith('/chat/completions'));
            for (let waited = 0; sends().length <= before && waited < 30000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
            const sent = sends()[before];
            if (!sent) throw new Error(`${parityCase.name}: upstream sent nothing`);
            const messages = JSON.stringify(sent.body.messages, null, 2);
            fs.writeFileSync(path.join(out, `${parityCase.name}.json`), `${messages}\n`);
            console.log(`${parityCase.name}: ${sent.body.messages.length} messages`);
            await page.close();
            continue;
        }
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
    await openai.close();
}
