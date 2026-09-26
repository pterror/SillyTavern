import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const MESSAGE_TEXT = [
    '"quoted" <q>tag q</q> *em* <u>under</u> **bold** `code` [link](https://example.com)',
    '',
    '> blockquote',
].join('\n');

const REASONING_TEXT = '"thought" *em*';

/** Computed styles of chat message text under the default theme. */
const EXPECTED_CHAT_STYLES = {
    'text q (from "quoted")': {
        color: 'rgb(225, 138, 36)',
        'font-style': 'normal',
        'font-weight': '500',
        'text-decoration': 'none',
        quotes: 'auto',
        '::before content': '""',
        '::after content': '""',
    },
    'text q (from <q>)': {
        color: 'rgb(225, 138, 36)',
        'font-style': 'normal',
        'font-weight': '500',
        'text-decoration': 'none',
        quotes: 'auto',
        '::before content': '""',
        '::after content': '""',
    },
    'text em': {
        color: 'rgb(145, 145, 145)',
        'font-style': 'italic',
        'font-weight': '500',
        'text-decoration': 'none',
        quotes: 'auto',
    },
    'text u': {
        color: 'rgb(188, 231, 207)',
        'font-style': 'normal',
        'font-weight': '500',
        'text-decoration': 'underline',
        quotes: 'auto',
    },
    'text strong': {
        color: 'rgb(220, 220, 210)',
        'font-style': 'normal',
        'font-weight': '700',
        'text-decoration': 'none',
        quotes: 'auto',
    },
    'text code': {
        color: 'rgba(255, 255, 255, 0.7)',
        'font-style': 'normal',
        'font-weight': '500',
        'text-decoration': 'none',
        quotes: 'auto',
    },
    'text blockquote': {
        color: 'rgb(220, 220, 210)',
        'font-style': 'normal',
        'font-weight': '500',
        'text-decoration': 'none',
        quotes: 'auto',
    },
    'text a': {
        color: 'rgb(225, 138, 36)',
        'font-style': 'normal',
        'font-weight': '500',
        'text-decoration': 'none',
        quotes: 'auto',
    },
    'reasoning q': {
        color: 'color(srgb 0.697059 0.526471 0.326471)',
        'font-style': 'normal',
        'font-weight': '500',
        'text-decoration': 'none',
        quotes: 'auto',
        '::before content': '""',
        '::after content': '""',
    },
    'reasoning em': {
        color: 'color(srgb 0.410745 0.410745 0.410745)',
        'font-style': 'italic',
        'font-weight': '500',
        'text-decoration': 'none',
        quotes: 'auto',
    },
};

/**
 * Renders a chat message from the message template and returns the computed styles of its text elements.
 * @param {import('@playwright/test').Page} page
 */
async function collectChatTextStyles(page) {
    return page.evaluate(async ({ messageText, reasoningText }) => {
        const { messageFormatting } = await import('/scripts/message-formatting.js');
        const template = document.querySelector('#message_template .mes');
        if (!template) throw new Error('Missing #message_template .mes');
        const mes = /** @type {HTMLElement} */ (template.cloneNode(true));
        mes.setAttribute('mesid', '0');
        document.getElementById('chat').append(mes);
        mes.querySelector('.mes_text').innerHTML = messageFormatting(messageText, 'Test', false, false, 0);
        const details = mes.querySelector('.mes_reasoning_details');
        details.setAttribute('data-has-content', 'true');
        details.setAttribute('open', '');
        mes.classList.add('reasoning');
        mes.querySelector('.mes_reasoning').innerHTML = messageFormatting(reasoningText, 'Test', false, false, 0, {}, true);

        const props = ['color', 'font-style', 'font-weight', 'text-decoration', 'quotes'];
        /** @param {Element} el */
        const styleOf = (el, withPseudo) => {
            const cs = getComputedStyle(el);
            /** @type {Record<string, string>} */
            const out = {};
            for (const p of props) out[p] = cs.getPropertyValue(p);
            if (withPseudo) {
                out['::before content'] = getComputedStyle(el, '::before').content;
                out['::after content'] = getComputedStyle(el, '::after').content;
            }
            return out;
        };
        const text = mes.querySelector('.mes_text');
        const reasoning = mes.querySelector('.mes_reasoning');
        const qs = text.querySelectorAll('q');
        const pick = (root, selector) => {
            const el = root.querySelector(selector);
            if (!el) throw new Error(`Missing ${selector} in ${root.className}: ${root.innerHTML}`);
            return el;
        };
        const result = {
            'text q (from "quoted")': styleOf(qs[0], true),
            'text q (from <q>)': styleOf(qs[1], true),
            'text em': styleOf(pick(text, 'em'), false),
            'text u': styleOf(pick(text, 'u'), false),
            'text strong': styleOf(pick(text, 'strong'), false),
            'text code': styleOf(pick(text, 'code'), false),
            'text blockquote': styleOf(pick(text, 'blockquote'), false),
            'text a': styleOf(pick(text, 'a'), false),
            'reasoning q': styleOf(pick(reasoning, 'q'), true),
            'reasoning em': styleOf(pick(reasoning, 'em'), false),
        };
        mes.remove();
        if (qs.length !== 2) throw new Error(`Expected 2 q in .mes_text, got ${qs.length}: ${text.innerHTML}`);
        return result;
    }, { messageText: MESSAGE_TEXT, reasoningText: REASONING_TEXT });
}

test.describe('Message text styles', () => {
    test.beforeEach(testSetup.awaitST);

    test('chat message text renders with the captured styles', async ({ page }) => {
        const styles = await collectChatTextStyles(page);
        expect(styles).toEqual(EXPECTED_CHAT_STYLES);
    });

    test('the character editor greeting preview strips the q quote marks', async ({ page }) => {
        const name = `MessageTextStyles-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const avatar = await page.evaluate(async ({ name, greeting }) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
            const form = new FormData();
            form.set('ch_name', name);
            form.set('first_mes', greeting);
            const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
            if (!response.ok) throw new Error(`create failed: ${response.status}`);
            return response.text();
        }, { name, greeting: '"quoted" <q>tag q</q>' });
        try {
            await openCharacterManagementDrawer(page);
            await page.evaluate(async (avatar) => {
                // @ts-ignore
                await SillyTavern.getContext().getCharacters();
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
            await openInfoTab(page, 'greeting');

            const preview = page.locator('.field_preview[data-for="greeting_field"]');
            await expect(preview).toHaveClass(/\bmes_text\b/);
            await expect(preview.locator('q')).toHaveCount(2);

            const result = await preview.evaluate((el) => ({
                insideMes: el.closest('.mes') !== null,
                pseudo: [...el.querySelectorAll('q')].map(q => [
                    getComputedStyle(q, '::before').content,
                    getComputedStyle(q, '::after').content,
                ]),
            }));
            expect(result.insideMes).toBe(false);
            expect(result.pseudo).toEqual([['""', '""'], ['""', '""']]);
        } finally {
            await page.evaluate(async (avatar) => {
                // @ts-ignore
                const headers = SillyTavern.getContext().getRequestHeaders();
                const response = await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
                if (!response.ok) throw new Error(`delete failed: ${response.status}`);
            }, avatar);
        }
    });
});
