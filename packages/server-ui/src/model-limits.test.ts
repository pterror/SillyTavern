import { expect, test } from 'vite-plus/test';
import { UNLOCKED_CONTEXT, limitsFor } from './model-limits.ts';

test("a model's name decides its context where the source has no list", () => {
    expect(limitsFor('openai', 'gpt-4.1-mini', false).context).toBe(1_000_000);
    expect(limitsFor('openai', 'gpt-4', false).context).toBe(8191);
    expect(limitsFor('openai', 'something-new', false).context).toBe(128_000);
    expect(limitsFor('claude', 'claude-opus-4-7', false).context).toBe(1_000_000);
    expect(limitsFor('claude', 'claude-3-haiku', false).context).toBe(200_000);
    expect(limitsFor('cohere', 'command-r-plus', false).context).toBe(128_000);
    expect(limitsFor('xai', 'grok-4-fast-reasoning', false).context).toBe(2_000_000);
    expect(limitsFor('zai', 'glm-4.5v', false).context).toBe(65535);
    expect(limitsFor('minimax', 'M2-her', true).context).toBe(65536);
});

test("a source's model list wins over the names, and a model it doesn't list falls back to them", () => {
    const models = [{ id: 'gemini-x', inputTokenLimit: 50_000, maxTemperature: 1.5 }, { id: 'gemini-2.5-pro' }];
    expect(limitsFor('makersuite', 'gemini-x', false, models)).toMatchObject({ context: 50_000, temperature: 1.5 });
    expect(limitsFor('makersuite', 'gemini-2.5-pro', false, models)).toMatchObject({
        context: 1_000_000,
        temperature: 2,
    });
    expect(limitsFor('makersuite', 'gemma-3-4b', false).temperature).toBe(1);
    const workers = [{ id: 'm', properties: [{ property_id: 'context_window', value: '24000' }] }];
    expect(limitsFor('workers_ai', 'm', false, workers)).toMatchObject({ context: 24_000, temperature: 5 });
    expect(limitsFor('aimlapi', 'a', false, [{ id: 'a', info: { contextLength: 9000 } }]).context).toBe(9000);
});

test('unlocked, the context is the unlocked maximum; custom is always', () => {
    expect(limitsFor('openai', 'gpt-4', true).context).toBe(UNLOCKED_CONTEXT);
    expect(limitsFor('custom', 'anything', false).context).toBe(UNLOCKED_CONTEXT);
});

test('penalties go from 0 to 1 for Cohere and from -2 to 2 for the rest', () => {
    expect(limitsFor('cohere', 'command', false).penalties).toEqual({ min: 0, max: 1 });
    expect(limitsFor('openai', 'gpt-4', false).penalties).toEqual({ min: -2, max: 2 });
});
