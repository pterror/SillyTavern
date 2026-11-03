import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { startLlamaCpp, createCharacter, openCharacter, connectLlamaCpp } from './llamacpp-mock.js';

test.describe('sending a message', () => {
    test.beforeEach(testSetup.awaitST);

    test('is one request, nothing is written after the reply, and the stored chat is as the page showed it', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const mock = await startLlamaCpp({ reply: n => `Mock reply ${n} ${s}.` });
        try {
            const avatar = await createCharacter(page, `Send ${s}`, `Greeting ${s}`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);

            /** @type {string[]} */
            const requests = [];
            const record = (/** @type {import('@playwright/test').Request} */ request) => {
                const url = new URL(request.url());
                if (url.pathname !== '/api/ui/events') requests.push(`${request.method()} ${url.pathname}`);
            };
            page.on('request', record);
            await chatBox(page).fill(`Hello ${s}`);
            await page.locator('#send_but').click();
            await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText(`Hello ${s}`, { timeout: 1000 });
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText(`Mock reply 1 ${s}`, { timeout: 30000 });
            await page.waitForTimeout(2500);

            await page.locator('#chat .mes[mesid="2"] .swipe_right').click();
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText(`Mock reply 2 ${s}`, { timeout: 30000 });
            await page.waitForTimeout(2500);
            page.off('request', record);
            expect(requests).toEqual(['POST /api/backends/text-completions/generate', 'POST /api/backends/text-completions/generate']);

            await page.reload();
            await testSetup.awaitST({ page });
            await openCharacter(page, avatar);
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText(`Mock reply 2 ${s}`, { timeout: 15000 });
            const stored = await page.evaluate(() => {
                // @ts-ignore
                const context = stTest.context();
                return { userExtra: context.chat[1].extra ?? {}, tainted: context.chatMetadata.tainted === true };
            });
            expect('reasoning' in stored.userExtra).toBe(false);
            expect(stored.tainted).toBe(true);
        } finally {
            await mock.close();
        }
    });

    for (const streaming of [true, false]) {
        test(`a new swipe shows nothing of the alternative it swiped from, then only what the server stored (${streaming ? 'streaming' : 'not streaming'})`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const mock = await startLlamaCpp({ reply: n => `Mock reply ${n} ${s}.`, delayMs: 1500 });
            try {
                const avatar = await createCharacter(page, `Stale ${s}`, `Greeting ${s}`);
                await openCharacter(page, avatar);
                await connectLlamaCpp(page, mock.url);
                // @ts-ignore
                await page.evaluate((streaming) => { stTest.context().textCompletionSettings.streaming = streaming; }, streaming);
                await chatBox(page).fill(`Hello ${s}`);
                await page.locator('#send_but').click();
                await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText(`Mock reply 1 ${s}`, { timeout: 30000 });

                await page.evaluate(async (s) => {
                    // @ts-ignore
                    const context = stTest.context();
                    const { chatOpPatch } = await import('/scripts/chat-store.js');
                    await chatOpPatch([{ node_id: context.chat[2].node_id, patch: {
                        'extra.media': [{ url: 'img/ai4.png', type: 'image', source: 'api' }],
                        'extra.inline_image': true,
                        'extra.reasoning': `Old thought ${s}`,
                        'extra.reasoning_type': 'parsed',
                    } }]);
                    const { reloadCurrentChat } = await import('/script.js');
                    await reloadCurrentChat();
                }, s);
                await expect(page.locator('#chat .mes[mesid="2"] .mes_media_wrapper img')).toHaveCount(1, { timeout: 10000 });
                await expect(page.locator('#chat .mes[mesid="2"] .mes_reasoning')).toContainText(`Old thought ${s}`);

                await page.evaluate((s) => {
                    // @ts-ignore
                    window.__stale = [];
                    // @ts-ignore
                    const newIndex = stTest.context().chat[2].swipes?.length ?? 1;
                    const sample = () => {
                        const mes = document.querySelector('#chat .mes[mesid="2"]');
                        // @ts-ignore
                        const message = stTest.context().chat[2];
                        const extra = message?.extra ?? {};
                        const seen = [];
                        const drawnOld = (mes?.querySelector('.mes_text')?.textContent ?? '').includes(`Mock reply 1 ${s}`);
                        // @ts-ignore
                        if (message?.swipe_id !== newIndex || drawnOld) { if (!window.__staleDone) requestAnimationFrame(sample); return; }
                        // @ts-ignore
                        window.__sampled = (window.__sampled ?? 0) + 1;
                        if (mes?.querySelector('.mes_media_wrapper img')) seen.push('media shown');
                        if (mes?.querySelector('.mes_reasoning')?.textContent?.includes(`Old thought ${s}`)) seen.push('reasoning shown');
                        if (Array.isArray(extra.media) && extra.media.length) seen.push('media held');
                        if (String(extra.reasoning ?? '').includes(`Old thought ${s}`)) seen.push('reasoning held');
                        // @ts-ignore
                        if (seen.length) window.__stale.push(seen.join(', '));
                        // @ts-ignore
                        if (!window.__staleDone) requestAnimationFrame(sample);
                    };
                    // @ts-ignore
                    window.__staleDone = false;
                    requestAnimationFrame(sample);
                }, s);
                await page.locator('#chat .mes[mesid="2"] .swipe_right').click();
                await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText(`Mock reply 2 ${s}`, { timeout: 30000 });
                await page.waitForTimeout(1000);
                // @ts-ignore
                const stale = await page.evaluate(() => { window.__staleDone = true; return { seen: [...new Set(window.__stale)], sampled: window.__sampled ?? 0 }; });
                expect(stale.seen).toEqual([]);
                expect(stale.sampled).toBeGreaterThan(30);

                const shown = await page.evaluate(async (avatar) => {
                    // @ts-ignore
                    const context = stTest.context();
                    const response = await fetch('/api/chats/open', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
                    const stored = (await response.json()).messages[2];
                    return { page: JSON.parse(JSON.stringify(context.chat[2].extra)), stored: stored.extra };
                }, avatar);
                expect(shown.page).toEqual(shown.stored);
            } finally {
                await mock.close();
            }
        });
    }

});
