import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/** @param {import('@playwright/test').Page} page */
async function stored(page) {
    return page.evaluate(async () => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const body = await (await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' })).json();
        return JSON.parse(body.settings);
    });
}

/** @param {import('@playwright/test').Page} page */
async function openTextPresets(page) {
    await page.evaluate(() => {
        // @ts-ignore
        $('#main_api').val('textgenerationwebui').trigger('change');
    });
    await page.locator('#leftNavDrawerIcon').click();
    const panel = page.locator('#textgenerationwebui_api-presets .st-presets');
    await expect(panel.getByRole('combobox')).toBeEnabled();
    return panel;
}

test.describe('Solid preset controls', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        await expect(page.locator('.st-preset-legacy, #settings_preset, #settings_preset_novel, #settings_preset_openai, #settings_preset_textgenerationwebui')).toHaveCount(0);
    });

    test('import, keyboard selection, rename, save, reorder, and delete persist through reload', async ({ page }) => {
        const panel = await openTextPresets(page);
        const name = `Solid-${Date.now()}`;
        await panel.locator('input[type=file]').setInputFiles({ name: `${name}.json`, mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify({ temp: 0.42, top_p: 0.8, genamt: 321, max_length: 4096 })) });
        await expect(panel.getByRole('combobox')).toContainText(name);
        await expect.poll(async () => (await stored(page)).textgenerationwebui_settings.preset).toBe(name);
        await expect(page.locator('#temp_counter_textgenerationwebui')).toHaveValue('0.42');
        expect((await stored(page)).amount_gen).toBe(321);

        await panel.getByRole('combobox').click();
        await panel.getByRole('combobox').press('Home');
        await panel.getByRole('combobox').press('Enter');
        await expect(panel.getByRole('combobox')).not.toContainText(name);
        await panel.getByRole('combobox').click();
        await page.getByRole('option', { name, exact: true }).click();
        await expect(panel.getByRole('combobox')).toContainText(name);

        const renamed = `${name}-renamed`;
        await panel.getByRole('button', { name: 'Rename current preset', exact: true }).click();
        await page.locator('dialog input').fill(renamed);
        await page.locator('dialog').getByRole('button', { name: 'OK', exact: true }).click();
        await expect(panel.getByRole('combobox')).toContainText(renamed);
        await panel.getByRole('button', { name: 'Update current preset', exact: true }).click();
        await expect(panel).toHaveAttribute('aria-busy', 'false');

        await panel.getByRole('button', { name: 'Reorder presets', exact: true }).click();
        const order = panel.getByRole('group', { name: 'Reorder presets', exact: true });
        await order.getByRole('button', { name: `Move up: ${renamed}`, exact: true }).click();
        await order.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect(order).toHaveCount(0);
        const savedOrder = (await stored(page)).power_user.preset_order.textgenerationwebui;
        expect(savedOrder).toContain(renamed);
        await page.reload();
        await expect(page.locator('#settings_preset_textgenerationwebui_control')).toContainText(renamed);
        expect((await stored(page)).power_user.preset_order.textgenerationwebui).toEqual(savedOrder);
        await page.locator('#leftNavDrawerIcon').click();
        await panel.getByRole('button', { name: 'Delete the preset', exact: true }).click();
        await page.locator('dialog').getByRole('button', { name: 'OK', exact: true }).click();
        await expect(panel.getByRole('combobox')).not.toContainText(renamed);
        await expect(panel.getByRole('alert')).toHaveCount(0);
    });

    test('a refused save retains the selection and shows the error', async ({ page }) => {
        const panel = await openTextPresets(page);
        const before = await panel.getByRole('combobox').textContent();
        await page.route('**/api/ui/action', async route => {
            const body = route.request().postDataJSON();
            if (body.type === 'presets.save') {
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Test save refused', views: [] }) });
            } else await route.continue();
        });
        await panel.getByRole('button', { name: 'Update current preset', exact: true }).click();
        await expect(panel.getByRole('alert')).toContainText('Test save refused');
        await expect(panel.getByRole('combobox')).toHaveText(before);
    });

    test('manager update and ordering APIs persist catalog changes without select elements', async ({ page }) => {
        const name = `Manager-${Date.now()}`;
        const result = await page.evaluate(async name => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const { power_user } = await import('/scripts/power-user.js');
            const manager = getPresetManager('openai');
            await manager.updateList(name, { temperature: 0.51, top_p: 0.8 });
            await manager.updateList('2', { temperature: 0.2 });
            await manager.updateList('10', { temperature: 0.1 });
            await manager.selectPreset(manager.findPreset(name));
            await manager.updatePreset();
            const names = manager.getAllPresets().reverse();
            power_user.preset_order.openai = names;
            await manager.applyOrder();
            return { names, shown: manager.getAllPresets(), selected: manager.getSelectedPresetName() };
        }, name);
        expect(result.shown).toEqual(result.names);
        expect(result.selected).toBe(name);
        const settings = await stored(page);
        expect(settings.oai_settings).toMatchObject({ preset_settings_openai: name, temp_openai: 0.51 });
        expect(settings.power_user.preset_order.openai).toEqual(result.names);
    });

    test('preset changes reach another tab and keep its generation catalog synchronized', async ({ page, context }) => {
        const panel = await openTextPresets(page);
        const second = await context.newPage();
        await testSetup.awaitST({ page: second });
        const name = `Shared-${Date.now()}`;
        await panel.locator('input[type=file]').setInputFiles({ name: `${name}.json`, mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify({ temp: 0.37, genamt: 111, max_length: 4096 })) });
        await expect(second.locator('#settings_preset_textgenerationwebui_control')).toContainText(name);
        await expect.poll(() => second.evaluate(async () => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            return getPresetManager('textgenerationwebui').getSelectedPresetName();
        })).toBe(name);
        await expect(second.locator('.st-presets [role=alert]')).toHaveCount(0);
        await second.close();
    });

    const imports = [
        { family: 'openai', data: { temperature: 0.33, top_p: 0.9 }, expected: { oai_settings: { temp_openai: 0.33 } } },
        { family: 'novel', data: { presetVersion: 3, parameters: { temperature: 1.1, max_length: 123, top_k: 20, top_p: 0.9 } }, expected: { nai_settings: { temperature: 1.1 }, amount_gen: 123 } },
        { family: 'kobold', data: { temp: 0.22, top_p: 0.9, genamt: 123, max_length: 4096 }, expected: { kai_settings: { temp: 0.22 } } },
    ];
    for (const { family, data, expected } of imports) {
        test(`${family}: import and restore use the Solid controls without a legacy settings conflict`, async ({ page }) => {
            await page.evaluate(family => {
                // @ts-ignore
                $('#main_api').val(family).trigger('change');
            }, family);
            await page.locator('#leftNavDrawerIcon').click();
            const panel = page.locator(`#${family}_api-presets .st-presets`);
            await expect(panel.getByRole('combobox')).toBeEnabled();
            const name = `Solid-${family}-${Date.now()}`;
            await panel.locator('input[type=file]').setInputFiles({ name: `${name}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
            await expect(panel.getByRole('combobox')).toContainText(name);
            await expect(panel).toHaveAttribute('aria-busy', 'false');
            expect(await stored(page)).toMatchObject(expected);
            await panel.getByRole('button', { name: 'Restore current preset', exact: true }).click();
            await page.locator('dialog').getByRole('button', { name: 'OK', exact: true }).click();
            await expect(panel).toHaveAttribute('aria-busy', 'false');
            await expect(panel.getByRole('combobox')).toContainText(name);
            await expect(panel.getByRole('alert')).toHaveCount(0);

            const catalog = await page.evaluate(async ({ family, name }) => {
                const { getPresetManager } = await import('/scripts/preset-manager.js');
                const manager = getPresetManager(family);
                const another = manager.getAllPresets().find(candidate => candidate !== name && candidate !== 'GUI KoboldAI Settings');
                await manager.selectPreset(manager.findPreset(another));
                const value = manager.findPreset(name);
                await manager.selectPreset(value);
                return { names: manager.getAllPresets(), selected: manager.getSelectedPresetName(), value: manager.getSelectedPreset(), wanted: value };
            }, { family, name });
            expect(catalog.names).toContain(name);
            expect(catalog.selected).toBe(name);
            expect(catalog.value).toBe(catalog.wanted);
            expect(await stored(page)).toMatchObject(expected);

        });
    }

    test('manager selection waits for Chat Completion extension hooks and settings application', async ({ page }) => {
        const name = `Hooks-${Date.now()}`;
        await page.evaluate(async name => {
            const { newUi } = await import('/scripts/new-ui-page.js');
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const { eventSource, event_types } = await import('/scripts/events.js');
            await newUi().presets.save('openai', name, { temperature: 0.41, extensions: {} }, false);
            window['presetHooks'] = { entered: false, after: false, selected: false, beforeCount: 0 };
            eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, async args => {
                if (args.presetName !== name) return;
                window['presetHooks'].beforeCount++;
                window['presetHooks'].entered = true;
                await new Promise(resolve => { window['releasePresetHook'] = resolve; });
                args.preset.extensions = { probe: 'extension hook finished' };
                await args.savePreset(name, args.preset, false);
            });
            eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => { window['presetHooks'].after = true; });
            const manager = getPresetManager('openai');
            window['presetSelection'] = manager.selectPreset(manager.findPreset(name)).then(() => { window['presetHooks'].selected = true; });
        }, name);
        await page.waitForFunction(() => window['presetHooks'].entered);
        expect(await page.evaluate(() => window['presetHooks'].selected)).toBe(false);
        await page.evaluate(() => window['releasePresetHook']());
        await page.evaluate(() => window['presetSelection']);
        expect(await page.evaluate(() => window['presetHooks'])).toMatchObject({ after: true, selected: true, beforeCount: 1 });
        expect((await stored(page)).oai_settings).toMatchObject({ preset_settings_openai: name, extensions: { probe: 'extension hook finished' } });
    });

    test('connection binding is a global preset preference synchronized across tabs', async ({ page, context }) => {
        await page.evaluate(() => { window['$']('#main_api').val('openai').trigger('change'); });
        await page.locator('#leftNavDrawerIcon').click();
        const checkbox = page.getByRole('checkbox', { name: 'Bind presets to API connections', exact: true });
        await expect(checkbox).toBeVisible();
        const second = await context.newPage();
        await testSetup.awaitST({ page: second });
        await checkbox.setChecked(true);
        await expect.poll(async () => (await stored(page)).oai_settings.bind_preset_to_connection).toBe(true);
        await expect(second.locator('#bind_preset_to_connection')).toBeChecked();
        await checkbox.setChecked(false);
        await expect.poll(async () => (await stored(page)).oai_settings.bind_preset_to_connection).toBe(false);
        await expect(second.locator('#bind_preset_to_connection')).not.toBeChecked();
        await second.close();
        await page.route('**/api/ui/action', async route => {
            if (route.request().postDataJSON().type === 'presets.bindConnection')
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Binding refused', views: [] }) });
            else await route.continue();
        });
        await checkbox.click();
        await expect(page.locator('#openai_api-presets [role="alert"]')).toContainText('Binding refused');
        await expect(checkbox).not.toBeChecked();
        expect((await stored(page)).oai_settings.bind_preset_to_connection).toBe(false);
    });

    test('KoboldAI GUI mode remains selectable and cannot overwrite a saved preset', async ({ page }) => {
        await page.evaluate(() => {
            // @ts-ignore
            $('#main_api').val('kobold').trigger('change');
        });
        await page.locator('#leftNavDrawerIcon').click();
        const panel = page.locator('#kobold_api-presets .st-presets');
        await expect(panel.getByRole('combobox')).toBeEnabled();
        await page.evaluate(async () => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const manager = getPresetManager('kobold');
            const name = manager.getAllPresets().find(name => name !== 'GUI KoboldAI Settings');
            await manager.selectPreset(manager.findPreset(name));
        });
        await panel.getByRole('combobox').click();
        await page.getByRole('option', { name: 'GUI KoboldAI Settings', exact: true }).click();
        await expect(panel.getByRole('button', { name: 'Update current preset', exact: true })).toBeDisabled();
        await expect.poll(async () => (await stored(page)).kai_settings.preset_settings).toBe('gui');
    });
});
