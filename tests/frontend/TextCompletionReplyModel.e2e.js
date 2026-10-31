import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { createCharacter, openCharacter } from './llamacpp-mock.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const MODEL = 'reply-model-backend-model';

/**
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
function startCompletionsServer() {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            const json = (/** @type {any} */ value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const path = (req.url ?? '').split('?')[0];
            if (path === '/v1/models') return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
            if (path === '/v1/completions') return json({ choices: [{ text: 'A reply.', index: 0, finish_reason: 'stop' }], model: MODEL });
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
            resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(done => server.close(() => done(undefined))) });
        });
    });
}

for (const type of ['koboldcpp', 'generic']) {
    test(`${type}: a reply records the backend's model`, async ({ page }) => {
        test.setTimeout(90000);
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const mock = await startCompletionsServer();
        try {
            await testSetup.awaitST({ page });
            const avatar = await createCharacter(page, `ReplyModel-${type}-${stamp}`);
            await openCharacter(page, avatar);

            if (!(await page.locator('#main_api').isVisible())) {
                await page.locator('#API-status-top').click();
                await page.locator('#main_api').waitFor({ state: 'visible' });
            }
            await page.selectOption('#main_api', 'textgenerationwebui', { force: true });
            await page.locator('#textgen_type').selectOption(type);
            await page.locator(`#${type}_api_url_text`).fill(mock.url);
            // @ts-ignore
            await page.evaluate((type) => { const field = $(`#${type}_api_url_text`); if (field.autocomplete('instance')) field.autocomplete('close'); }, type);
            await page.locator('#api_button_textgenerationwebui').click();
            // @ts-ignore
            await expect.poll(() => page.evaluate(() => SillyTavern.getContext().onlineStatus), { timeout: 15000 }).toBe(MODEL);
            await page.locator('#API-status-top').click();
            // @ts-ignore
            await page.evaluate(() => { SillyTavern.getContext().textCompletionSettings.streaming = false; });
            await page.waitForTimeout(2500);

            await chatBox(page).fill(`Question ${stamp}`);
            await page.locator('#send_but').click();
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('A reply.', { timeout: 30000 });

            const stored = await page.evaluate(async (avatar) => {
                // @ts-ignore
                const headers = SillyTavern.getContext().getRequestHeaders();
                const opened = await (await fetch('/api/chats/open', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) })).json();
                return opened.messages?.[2]?.extra ?? null;
            }, avatar);
            expect(stored).toMatchObject({ api: type, model: MODEL });
        } finally {
            await mock.close();
        }
    });
}
