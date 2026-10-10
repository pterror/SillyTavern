import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, chatBox } from './frontent-test-utils.js';

// A reply's prompt itemization is kept with the reply on the server. Opening a chat reads none of them: each message
// says whether it has one, which shows its "Prompt" button. Opening the view fetches that one message's, and the one
// it is diffed against only when the diff is asked for.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @param {string} rawPrompt */
const itemization = (rawPrompt) => ({
    main_api: 'textgenerationwebui', rawPrompt, finalPrompt: rawPrompt, storyString: 'Story.', mesSendString: rawPrompt,
    examplesString: '', worldInfoString: '', allAnchors: '', promptBias: '', padding: 0, this_max_context: 4096,
});

/**
 * The itemized-prompt requests the page makes while `run` runs.
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} run
 */
async function itemizationRequestsDuring(page, run) {
    /** @type {string[]} */
    const seen = [];
    const listener = (/** @type {import('@playwright/test').Request} */ request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/itemized-prompts/')) seen.push(`${path} ${request.postData() ?? ''}`);
    };
    page.on('request', listener);
    try {
        await run();
        await page.waitForTimeout(300);
    } finally {
        page.off('request', listener);
    }
    return seen;
}

test('opening a chat reads no itemization; the Prompt view fetches its message\'s, and the previous one on asking', async ({ page }) => {
    await testSetup.awaitST({ page });
    await openCharacterManagementDrawer(page);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const { avatar, ids } = await page.evaluate(async ({ name, first, second }) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Welcome in.');
        const created = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        const avatar = await created.text();
        await context.getCharacters();
        const { selectCharacterByAvatar, sendMessageAsUser } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
        await sendMessageAsUser('A question.', '');
        const userNode = context.chat[1].node_id;
        const appended = await (await fetch('/api/chats/message/append', {
            method: 'POST', headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, after_node_id: userNode, messages: [{ name, is_user: false, mes: 'An answer.', send_date: Date.now(), extra: {} }] }),
        })).json();
        const ids = [context.chat[0].node_id, userNode, appended.node_ids[0]];
        const set = await fetch('/api/itemized-prompts/set', {
            method: 'POST', headers: context.getRequestHeaders(),
            body: JSON.stringify({ items: [{ node_id: ids[0], entry: first }, { node_id: ids[2], entry: second }] }),
        });
        if (!set.ok) throw new Error(`set failed: ${set.status}`);
        return { avatar, ids };
    }, { name: `Itemized-${stamp}`, first: itemization('First prompt.'), second: itemization('Second prompt.') });

    await page.reload();
    await testSetup.awaitST({ page });
    const atOpen = await itemizationRequestsDuring(page, async () => {
        await page.evaluate(async (avatar) => {
            // @ts-ignore
            await SillyTavern.getContext().getCharacters();
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
        }, avatar);
        await expect(page.locator('#chat .mes')).toHaveCount(3);
    });
    expect(atOpen).toEqual([]);
    // The button sits in the message's collapsed extra buttons, so it is checked by its own display.
    await expect(page.locator('#chat .mes[mesid="0"] .mes_prompt')).not.toHaveCSS('display', 'none');
    await expect(page.locator('#chat .mes[mesid="1"] .mes_prompt')).toHaveCSS('display', 'none');
    await expect(page.locator('#chat .mes[mesid="2"] .mes_prompt')).not.toHaveCSS('display', 'none');

    const atView = await itemizationRequestsDuring(page, async () => {
        await page.locator('#chat .mes[mesid="2"] .mes_prompt').dispatchEvent('pointerup');
        await expect(page.locator('#diffPrevPrompt')).toBeVisible();
    });
    expect(atView).toEqual([`/api/itemized-prompts/message ${JSON.stringify({ node_id: ids[2] })}`]);

    const atDiff = await itemizationRequestsDuring(page, async () => {
        await page.locator('#diffPrevPrompt').click();
        await expect(page.locator('#rawPromptWrapper')).toContainText('Second');
    });
    expect(atDiff).toEqual([`/api/itemized-prompts/message ${JSON.stringify({ node_id: ids[0] })}`]);
});

const MODEL = 'itemized-model';
const REPLY = 'The tide turns at noon.';

function startLlamaCpp() {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const json = (value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const path = (req.url ?? '').split('?')[0];
            if (path === '/props') return json({ model_alias: MODEL, model_path: `/models/${MODEL}.gguf`, build_info: 'b-ipod', default_generation_settings: { n_ctx: 8192 } });
            if (path === '/v1/models') return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
            if (path === '/tokenize') {
                const content = String(JSON.parse(body || '{}').content ?? '');
                return json({ tokens: content.split(/(?=\s)/).filter(Boolean).map((_, i) => 100 + i) });
            }
            if (path === '/completion' && JSON.parse(body || '{}').stream === false) {
                return json({ content: REPLY, stop: true, model: MODEL, tokens_predicted: 6, tokens_evaluated: 10 });
            }
            if (path === '/completion') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ content: REPLY.slice(0, 9), stop: false })}\n\n`);
                res.write(`data: ${JSON.stringify({ content: REPLY.slice(9), stop: false })}\n\n`);
                res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
                return;
            }
            if (path === '/health' || path === '/slots') return json({});
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
            resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(done => server.close(() => done())) });
        });
    });
}

/** @param {import('@playwright/test').Page} page @param {string} url */
async function connectLlamaCpp(page, url) {
    if (!(await page.locator('#main_api').isVisible())) {
        await page.locator('#API-status-top').click();
        await page.locator('#main_api').waitFor({ state: 'visible' });
    }
    await page.selectOption('#main_api', 'textgenerationwebui', { force: true });
    await page.locator('#textgen_type').selectOption('llamacpp');
    await page.locator('#llamacpp_api_url_text').fill(url);
    await page.locator('#api_button_textgenerationwebui').click();
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().onlineStatus), { timeout: 15000 }).not.toBe('no_connection');
    await page.locator('#API-status-top').click();
}

for (const streaming of [true, false]) {
    test(`a generated reply (${streaming ? 'streaming' : 'not streaming'}) is stored with its itemization, and shows its Prompt button at once and after a reload`, async ({ page }) => {
        const mock = await startLlamaCpp();
        try {
            await testSetup.awaitST({ page });
            await openCharacterManagementDrawer(page);
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await page.evaluate(async (name) => {
                // @ts-ignore
                const context = SillyTavern.getContext();
                const form = new FormData();
                form.set('ch_name', name);
                form.set('first_mes', 'Hello.');
                const created = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
                const avatar = await created.text();
                await context.getCharacters();
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
                return avatar;
            }, `Generated-${stamp}`);
            await connectLlamaCpp(page, mock.url);
            await page.evaluate((streaming) => {
                // @ts-ignore
                SillyTavern.getContext().textCompletionSettings.streaming = streaming;
            }, streaming);
            // The connection's settings reach the server through a debounced save.
            await page.waitForTimeout(2500);

            /** @type {any} */
            let sentItemization = null;
            page.on('request', (request) => {
                if (new URL(request.url()).pathname === '/api/backends/text-completions/generate') {
                    sentItemization = JSON.parse(request.postData() ?? '{}').itemization ?? null;
                }
            });
            await chatBox(page).fill(`When does it turn ${stamp}?`);
            await page.locator('#send_but').click();
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText(REPLY, { timeout: 30000 });
            await expect(page.locator('#send_but')).toBeVisible({ timeout: 15000 });
            await expect(page.locator('#chat .mes[mesid="2"] .mes_prompt')).not.toHaveCSS('display', 'none');
            expect(sentItemization?.main_api).toBe('textgenerationwebui');
            expect(sentItemization).not.toHaveProperty('mesId');

            const stored = await page.evaluate(async () => {
                // @ts-ignore
                const context = SillyTavern.getContext();
                const response = await fetch('/api/itemized-prompts/message', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ node_id: context.chat[2].node_id }) });
                return response.ok ? (await response.json()).entry : null;
            });
            expect(stored?.main_api).toBe('textgenerationwebui');
            expect(typeof stored?.rawPrompt).toBe('string');
            expect(stored.rawPrompt).toContain(`When does it turn ${stamp}?`);

            await page.reload();
            await testSetup.awaitST({ page });
            await page.evaluate(async (avatar) => {
                // @ts-ignore
                await SillyTavern.getContext().getCharacters();
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            await expect(page.locator('#chat .mes')).toHaveCount(3);
            await expect(page.locator('#chat .mes[mesid="1"] .mes_prompt')).toHaveCSS('display', 'none');
            await expect(page.locator('#chat .mes[mesid="2"] .mes_prompt')).not.toHaveCSS('display', 'none');
        } finally {
            await mock.close();
        }
    });
}
