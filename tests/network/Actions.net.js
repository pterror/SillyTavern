import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect } from '../frontend/fixtures.js';
import { testSetup, chatBox, openCharacterManagementDrawer } from '../frontend/frontent-test-utils.js';
import { startLlamaCpp, createCharacter, openCharacter, connectLlamaCpp } from '../frontend/llamacpp-mock.js';
import { PROFILES, setLink, shapePort } from './link.js';
import { traceAction, describeTrace } from './trace.js';

const SEND_BUDGET_MS = 200;

const test = base.extend({
    shaped: [async ({ stServer }, use) => {
        shapePort(Number(new URL(stServer.baseURL).port));
        await use(undefined);
    }, { scope: 'worker', auto: true }],
});

for (const profile of [PROFILES.local, PROFILES['3g'], PROFILES['phone over vpn'], PROFILES.lossy]) {
    test(`${profile.name}: each user action is one request; a message shows within ${SEND_BUDGET_MS} ms of sending`, async ({ page }, testInfo) => {
        setLink(PROFILES.local);
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const mock = await startLlamaCpp({ reply: n => `Mock reply ${n} ${s}.` });
        /** @type {import('./trace.js').ActionTrace[]} */
        const traces = [];
        const run = async (/** @type {Parameters<typeof traceAction>[1]} */ options) => {
            const trace = await traceAction(page, options);
            traces.push(trace);
            console.log(describeTrace(trace));
            return trace;
        };
        try {
            await testSetup.awaitST({ page });
            const first = await createCharacter(page, `Net A ${s}`, `Greeting A ${s}`);
            const second = await createCharacter(page, `Net B ${s}`, `Greeting B ${s}`);
            await openCharacter(page, first);
            await connectLlamaCpp(page, mock.url);
            setLink({ ...profile });

            const send = await run({
                action: 'send a message',
                profile: profile.name,
                act: async () => {
                    await chatBox(page).fill(`Hello ${s}`);
                    await page.locator('#send_but').click();
                },
                visible: { selector: '#chat .mes[mesid="1"] .mes_text', text: `Hello ${s}` },
            });
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText(`Mock reply 1 ${s}`, { timeout: 60000 });

            await run({
                action: 'swipe to a new reply',
                profile: profile.name,
                act: () => page.locator('#chat .mes[mesid="2"] .swipe_right').click(),
                visible: { selector: '#chat .mes[mesid="2"] .mes_text', text: `Mock reply 2 ${s}` },
            });
            await run({
                action: 'swipe back to a reply',
                profile: profile.name,
                act: () => page.locator('#chat .mes[mesid="2"] .swipe_left').click(),
                visible: { selector: '#chat .mes[mesid="2"] .mes_text', text: `Mock reply 1 ${s}` },
            });
            await run({
                action: 'open the alternatives list',
                profile: profile.name,
                act: () => page.locator('#chat .mes[mesid="2"] .swipes-counter').click(),
                visible: { selector: 'dialog.alternatives[open] li.alternative .mes_text', text: `Mock reply 2 ${s}` },
            });
            await page.keyboard.press('Escape');
            await expect(page.locator('dialog.alternatives[open]')).toHaveCount(0);

            await run({
                action: 'open a drawer (World Info)',
                profile: profile.name,
                act: () => page.locator('#WIDrawerIcon').click(),
                visible: { selector: '#WorldInfo.openDrawer' },
            });
            await page.locator('#WIDrawerIcon').click();
            await expect(page.locator('#WorldInfo.openDrawer')).toHaveCount(0);

            await page.locator('#options_button').click();
            await run({
                action: 'open the chat list',
                profile: profile.name,
                act: () => page.locator('#option_select_chat').click(),
                visible: { selector: '#select_chat_div .select_chat_block', text: `Mock reply 1 ${s}` },
            });
            await page.locator('#select_chat_cross').click();

            setLink(PROFILES.local);
            if (await page.locator('#right-nav-panel.openDrawer').count()) {
                await page.locator('#rightNavDrawerIcon').click();
                await expect(page.locator('#right-nav-panel.openDrawer')).toHaveCount(0);
            }
            setLink({ ...profile });
            await run({
                action: 'open the character list',
                profile: profile.name,
                act: () => page.locator('#rightNavDrawerIcon').click(),
                visible: { selector: `#right-nav-panel.openDrawer #rm_print_characters_block .character_select[data-avatar="${second}"]` },
            });
            await openCharacterManagementDrawer(page);
            await run({
                action: 'switch character',
                profile: profile.name,
                act: () => page.locator(`#rm_print_characters_block .character_select[data-avatar="${second}"]`).click(),
                visible: { selector: '#chat .mes[mesid="0"] .mes_text', text: `Greeting B ${s}` },
            });
            setLink(PROFILES.local);
            await openCharacterManagementDrawer(page);
            await expect(page.locator(`#rm_print_characters_block .character_select[data-avatar="${first}"]`)).toBeVisible();
            setLink({ ...profile });
            await run({
                action: 'open a chat with history (back to the first character)',
                profile: profile.name,
                act: () => page.locator(`#rm_print_characters_block .character_select[data-avatar="${first}"]`).click(),
                visible: { selector: '#chat .mes[mesid="1"] .mes_text', text: `Hello ${s}` },
            });

            setLink(PROFILES.local);
            await page.locator('#options_button').click();
            await page.locator('#option_select_chat').click();
            await page.locator('#newChatFromManageScreenButton').click();
            await expect(page.locator('#chat .mes')).toHaveCount(1);
            await page.locator('#options_button').click();
            await page.locator('#option_select_chat').click();
            await expect(page.locator('#select_chat_div .select_chat_block').first()).toBeVisible();
            const earlier = page.locator('#select_chat_div .select_chat_block', { hasText: `Mock reply 1 ${s}` });
            const listed = await earlier.waitFor({ timeout: 5000 }).then(() => true, () => false);
            expect.soft(listed, 'after New Chat, the chat list still lists the earlier chat').toBe(true);
            setLink({ ...profile });
            if (listed) {
                await run({
                    action: 'open a chat from the chat list',
                    profile: profile.name,
                    act: () => earlier.click(),
                    visible: { selector: '#chat .mes[mesid="1"] .mes_text', text: `Hello ${s}` },
                });
            }

            for (const trace of traces) {
                expect.soft(trace.requests.length, `${trace.action}: requests\n${describeTrace(trace)}`).toBeLessThanOrEqual(1);
                expect.soft(trace.roundTrips, `${trace.action}: round trips in sequence\n${describeTrace(trace)}`).toBeLessThanOrEqual(1);
            }
            expect.soft(send.visibleMs, `send: time to the message shown\n${describeTrace(send)}`).not.toBeNull();
            expect.soft(/** @type {number} */ (send.visibleMs), `send: time to the message shown\n${describeTrace(send)}`).toBeLessThan(SEND_BUDGET_MS);
        } finally {
            setLink(PROFILES.local);
            fs.mkdirSync(testInfo.project.outputDir, { recursive: true });
            fs.appendFileSync(path.join(testInfo.project.outputDir, 'network-traces.jsonl'), traces.map(t => JSON.stringify(t)).join('\n') + (traces.length ? '\n' : ''));
            await testInfo.attach('traces', { body: traces.map(describeTrace).join('\n\n'), contentType: 'text/plain' });
            await mock.close();
        }
    });
}
