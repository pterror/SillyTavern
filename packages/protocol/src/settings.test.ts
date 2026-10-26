import { expect, test } from 'vite-plus/test';
import { FIELDS, LIMITS, rangeOf } from './settings.ts';

test('every field is one control at one place', () => {
    const ids = [...FIELDS.map((f) => f.id), ...FIELDS.flatMap((f) => f.inputs ?? [])];
    expect(new Set(ids).size).toBe(ids.length);
    const paths = FIELDS.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
});

test('ranges are ranges, choices have an input per option, selects have options', () => {
    for (const field of FIELDS) {
        if (field.kind === 'range' || field.kind === 'number') {
            if (field.min !== undefined && field.max !== undefined) expect(field.min, field.id).toBeLessThan(field.max);
            if (field.step !== undefined) expect(field.step, field.id).toBeGreaterThan(0);
        }
        if (field.kind === 'choice') expect(field.inputs?.length, field.id).toBe(field.options?.length);
        if (field.kind === 'select') expect(field.options?.length, field.id).toBeGreaterThan(0);
        expect(field.label.length, field.id).toBeGreaterThan(0);
    }
});

test('a context-limited field follows the unlock; one with meaningful low values keeps its minimum', () => {
    const context = FIELDS.find((f) => f.id === 'max_context');
    const repetition = FIELDS.find((f) => f.id === 'rep_pen_range_textgenerationwebui');
    const response = FIELDS.find((f) => f.id === 'amount_gen');
    if (!context || !repetition || !response) throw new Error('missing fields');
    expect(rangeOf(context, false)).toEqual(LIMITS.context.locked);
    expect(rangeOf(context, true)).toEqual(LIMITS.context.unlocked);
    expect(rangeOf(repetition, true)).toEqual({
        min: repetition.min,
        max: LIMITS.context.unlocked.max,
        step: repetition.step,
    });
    expect(rangeOf(response, true)).toEqual(LIMITS.response.unlocked);
});
