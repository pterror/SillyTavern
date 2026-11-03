import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { danglingPublicImports, unusedPublicExports } from '../scripts/public-exports.mjs';

describe('public/ modules', () => {
    test('export only what the app or its tests import: nothing is kept for code outside this repository', () => {
        expect(unusedPublicExports(path.resolve(process.cwd(), '..'))).toEqual([]);
    });

    test('are imported only for names they export', () => {
        expect(danglingPublicImports(path.resolve(process.cwd(), '..'))).toEqual([]);
    });
});
