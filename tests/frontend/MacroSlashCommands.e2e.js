import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

test.describe('MacroSlashCommands', () => {
    test.beforeEach(testSetup.awaitST);

    test.describe('Parser Flags', () => {
        test('should bypass REPLACE_GETVAR', async ({ page }) => {
            const output = await page.evaluate(async () => {
                const { executeSlashCommandsWithOptions } = await import('./scripts/slash-commands.js');


                return (await executeSlashCommandsWithOptions('/parser-flag REPLACE_GETVAR || /setvar key=x \\{\\{lastMessageId}} || /pass {{getvar::x}}')).pipe;
            });

            expect(output).toBe('{{lastMessageId}}');
        });
    });

    test.describe('{{pipe}} Macro', () => {
        test('should support {{pipe}} macro', async ({ page }) => {
            const output = await page.evaluate(async () => {
                const { executeSlashCommandsWithOptions } = await import('./scripts/slash-commands.js');


                return (await executeSlashCommandsWithOptions('/pass Hello World || /pass {{pipe}}')).pipe;
            });

            expect(output).toBe('Hello World');
        });
    });

    test.describe('{{var}} Macro', () => {
        test('should support {{var::key}} macro', async ({ page }) => {
            const output = await page.evaluate(async () => {
                const { executeSlashCommandsWithOptions } = await import('./scripts/slash-commands.js');


                return (await executeSlashCommandsWithOptions('/let key=greeting Hello || /pass {{var::greeting}}')).pipe;
            });

            expect(output).toBe('Hello');
        });

        test('should support {{var::key::index}} macro', async ({ page }) => {
            const output = await page.evaluate(async () => {
                const { executeSlashCommandsWithOptions } = await import('./scripts/slash-commands.js');


                return (await executeSlashCommandsWithOptions('/let key=list ["item1","item2","item3"] || /pass {{var::list::1}}')).pipe;
            });

            expect(output).toBe('item2');
        });

        test('should not fail on unknown variable keys', async ({ page }) => {
            const output = await page.evaluate(async () => {
                const { executeSlashCommandsWithOptions } = await import('./scripts/slash-commands.js');

                return (await executeSlashCommandsWithOptions('/pass {{var::unknownKey}}')).pipe;
            });

            expect(output).toBe('');
        });

        test('should not fail on out-of-bounds variable index', async ({ page }) => {
            const output = await page.evaluate(async () => {
                const { executeSlashCommandsWithOptions } = await import('./scripts/slash-commands.js');


                return (await executeSlashCommandsWithOptions('/let key=test {"key":"value"} || /pass {{var::test::error}}')).pipe;
            });

            expect(output).toBe('');
        });
    });

    test.describe('Custom Scope Macros', () => {
        test('should support {{timesIndex}} in /times command', async ({ page }) => {
            const output = await page.evaluate(async () => {
                const { executeSlashCommandsWithOptions } = await import('./scripts/slash-commands.js');


                return (await executeSlashCommandsWithOptions('/times 1 {: /pass {{timesIndex}} :}')).pipe;
            });

            expect(output).toBe('0');
        });

        test('should support custom SlashCommandScope macros', async ({ page }) => {
            const output = await page.evaluate(async () => {
                const { executeSlashCommandsWithOptions } = await import('./scripts/slash-commands.js');
                const { SlashCommandScope } = await import('./scripts/slash-commands/SlashCommandScope.js');


                const customScope = new SlashCommandScope(null);
                customScope.setMacro('custom', 'CUSTOM_VALUE');
                return (await executeSlashCommandsWithOptions('/pass {{custom}}', { scope: customScope })).pipe;
            });

            expect(output).toBe('CUSTOM_VALUE');
        });
    });
});
