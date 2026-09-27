import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// NixOS host: the Playwright-managed Chromium download is missing system libs, so fall back
// to the system-provided Chrome (only when explicitly pointed at it) rather than requiring a
// FHS-compatible browser install.
if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}
if (process.env.PLAYWRIGHT_BASIC_AUTH_USER) {
    test.use({
        httpCredentials: {
            username: process.env.PLAYWRIGHT_BASIC_AUTH_USER,
            password: process.env.PLAYWRIGHT_BASIC_AUTH_PASS ?? '',
        },
    });
}

// The prompt manager's per-prompt tokens mark their basis like the other on-screen counts: a wrapper
// span takes the tokens span's place as the grid child and holds the `~` and marker spans, so the
// tokens span's text and data-pm-tokens stay what upstream writes.

/**
 * Makes the server's /current/count and /current/tokenizer answers say the model is unknown to the map
 * (basis `unknown`, an estimate), keeping every count a plain number.
 * @param {import('@playwright/test').Page} page
 */
async function answerUnknownTokenizer(page) {
    const tokenizer = {
        id: 0,
        name: 'None / Estimated',
        basis: 'unknown',
        key: 'e2e-unknown-model',
        messages: { unknownModel: 'This model has no known tokenizer.' },
    };
    await page.route('**/api/tokenizers/current/tokenizer', route => route.fulfill({ json: { tokenizer } }));
    await page.route('**/api/tokenizers/current/count', (route) => {
        const body = route.request().postDataJSON();
        if (Array.isArray(body?.texts)) {
            return route.fulfill({ json: { counts: body.texts.map(text => Math.ceil(text.length / 3.35) + (body.padding ?? 0)), tokenizer } });
        }
        return route.fulfill({ json: { count: 7, tokenizer } });
    });
}

/**
 * Creates and selects a character, switches to Chat Completion and opens the prompt manager, whose dry
 * run fills the per-prompt counts.
 * @param {import('@playwright/test').Page} page
 */
async function openPromptManagerWithCounts(page) {
    const name = `PromptManagerCountBasis-${Date.now()}`;
    await page.locator('#rightNavDrawerIcon').click();
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button').evaluate(el => el.click());
    await page.locator('.character_select', { hasText: name }).first().click();
    await page.waitForFunction(n => window['SillyTavern'].getContext().name2 === n, name);

    await page.locator('#leftNavDrawerIcon').click();
    // #main_api is select2-enhanced; force sets the hidden native <select>, which select2 listens to.
    await page.selectOption('#main_api', 'openai', { force: true });
    await expect(page.locator('#completion_prompt_manager_list li[data-pm-identifier="main"] .prompt_manager_prompt_tokens'))
        .toHaveAttribute('data-pm-tokens', /^\d+$/, { timeout: 15000 });
}

test.describe('prompt manager per-prompt count basis', () => {
    test.beforeEach(async ({ page }) => {
        await answerUnknownTokenizer(page);
        await testSetup.awaitST({ page });
    });

    test('a counted prompt shows ~ and the marker in its wrapper, and its tokens span stays upstream\'s', async ({ page }) => {
        await openPromptManagerWithCounts(page);

        const row = page.locator('#completion_prompt_manager_list li[data-pm-identifier="main"]');
        const wrapper = row.locator(':scope > span.prompt_manager_prompt_tokens_wrapper');
        await expect(wrapper).toHaveCount(1);
        const tokens = wrapper.locator(':scope > span.prompt_manager_prompt_tokens');
        await expect(tokens).toHaveCount(1);

        await expect(tokens.locator('xpath=preceding-sibling::*[1]')).toHaveClass(/\btoken_count_approx\b/);
        await expect(tokens.locator('xpath=preceding-sibling::*[1]')).toHaveText('~');
        await expect(tokens.locator('xpath=following-sibling::*[1]')).toHaveClass(/\btoken_count_basis\b/);
        await expect(tokens.locator('xpath=following-sibling::*[1]/i[contains(@class, "fa-circle-question")]')).toHaveCount(1);

        const pmTokens = await tokens.getAttribute('data-pm-tokens');
        expect(pmTokens).toMatch(/^\d+$/);
        expect(await tokens.evaluate(el => el.textContent)).toBe(' ' + pmTokens);

        // The grid keeps upstream's children: drag handle, name, controls and the tokens column.
        expect(await row.evaluate(el => el.children.length)).toBe(4);
    });

    test('a prompt with no tokens shows - with no marker', async ({ page }) => {
        await openPromptManagerWithCounts(page);

        const tokens = page.locator('#completion_prompt_manager_list li .prompt_manager_prompt_tokens[data-pm-tokens="-"]').first();
        await expect(tokens).toHaveCount(1);
        const wrapper = tokens.locator('xpath=..');
        await expect(wrapper).toHaveClass(/\bprompt_manager_prompt_tokens_wrapper\b/);
        await expect(wrapper.locator('.token_count_approx')).toHaveCount(0);
        await expect(wrapper.locator('.token_count_basis')).toHaveCount(0);
        await expect(wrapper.locator('.fa-circle-question')).toHaveCount(0);
        expect(await tokens.evaluate(el => el.textContent)).toBe(' -');
    });

    test('the tokens column lines up with the header, and the warning span looks as upstream\'s does', async ({ page }) => {
        await openPromptManagerWithCounts(page);

        const header = page.locator('#completion_prompt_manager_list li.completion_prompt_manager_list_head .prompt_manager_prompt_tokens');
        const headerBox = await header.boundingBox();
        const counted = page.locator('#completion_prompt_manager_list li[data-pm-identifier="main"] .prompt_manager_prompt_tokens_wrapper');
        const countedBox = await counted.boundingBox();
        const empty = page.locator('#completion_prompt_manager_list li .prompt_manager_prompt_tokens[data-pm-tokens="-"]').first();
        const emptyBox = await empty.boundingBox();
        expect(Math.abs((countedBox.x + countedBox.width) - (headerBox.x + headerBox.width))).toBeLessThanOrEqual(1.5);
        expect(Math.abs((emptyBox.x + emptyBox.width) - (headerBox.x + headerBox.width))).toBeLessThanOrEqual(1.5);

        // Upstream's tokens span is a direct grid child. Put a copy of it there and compare its warning
        // span with the real one, both as the empty span every row has and as the chat history warning.
        const styles = await page.evaluate(() => {
            const row = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="main"]');
            const real = row.querySelector('.prompt_manager_prompt_tokens > span');
            const upstreamTokens = row.querySelector('.prompt_manager_prompt_tokens').cloneNode(true);
            const upstream = upstreamTokens.querySelector('span');
            row.appendChild(upstreamTokens);
            const read = (el) => {
                const style = getComputedStyle(el);
                const box = el.getBoundingClientRect();
                return {
                    width: box.width,
                    height: box.height,
                    opacity: style.opacity,
                    marginLeft: style.marginLeft,
                    filter: style.filter,
                    cursor: style.cursor,
                    display: style.display,
                };
            };
            const result = { empty: [read(real), read(upstream)] };
            const warningClass = 'fa-solid tooltip fa-triangle-exclamation text_warning';
            real.className = warningClass;
            upstream.className = warningClass;
            result.warning = [read(real), read(upstream)];
            upstreamTokens.remove();
            return result;
        });
        expect(styles.empty[0]).toEqual(styles.empty[1]);
        expect(styles.warning[0]).toEqual(styles.warning[1]);
    });
});
