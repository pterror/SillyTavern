import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

test.describe('MacrosParser (legacy shim)', () => {
    test.beforeEach(testSetup.awaitST);

    test('the deprecated evaluateMacros resolves registered macros and its env through the engine', async ({ page }) => {
        const output = await page.evaluate(async () => {
            const { MacrosParser, evaluateMacros } = await import('./scripts/macros.js');

            MacrosParser.registerMacro('legacyParserTest', 'LEGACY_OK', 'Legacy parser test');

            const env = { envValue: 'ENV_OK', envFunction: (nonce) => typeof nonce === 'string' ? 'FN_OK' : 'NO_NONCE' };
            const result = evaluateMacros('Value: {{legacyParserTest}} {{envValue}} {{envFunction}} {{newline}}.', env, (x) => `[${x}]`);

            MacrosParser.unregisterMacro('legacyParserTest');

            return result;
        });

        expect(output).toBe('Value: [LEGACY_OK] [ENV_OK] [FN_OK] [\n].');
    });

    test('a macro it registers is resolved by substituteParams', async ({ page }) => {
        const output = await page.evaluate(async () => {
            const { MacrosParser } = await import('./scripts/macros.js');
            const { substituteParams } = await import('./script.js');

            MacrosParser.registerMacro('engineParserTest', 'ENGINE_OK', 'Engine parser test');

            const result = substituteParams('Value: {{engineParserTest}}.', {});

            MacrosParser.unregisterMacro('engineParserTest');

            return result;
        });

        expect(output).toBe('Value: ENGINE_OK.');
    });
});
