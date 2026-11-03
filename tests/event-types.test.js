import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

const root = path.resolve(process.cwd(), '..');
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'lib', '.git', 'data', 'dist', 'backups', '.claude', 'test-results']);

/**
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function jsFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name)) jsFiles(path.join(dir, entry.name), out);
        } else if (/\.m?js$/.test(entry.name)) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

const eventsSource = fs.readFileSync(path.join(root, 'public/scripts/events.js'), 'utf8');
const declaration = eventsSource.slice(eventsSource.indexOf('export const event_types = {'), eventsSource.indexOf('};', eventsSource.indexOf('export const event_types = {')));
const declared = new Set([...declaration.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map(match => match[1]));

const appFiles = [...jsFiles(path.join(root, 'public')), path.join(root, 'public/script.js')];
const testFiles = jsFiles(path.join(root, 'tests'));
const REFERENCE = /\b(?:event_types|eventTypes)\.([A-Z][A-Z0-9_]*)\b/g;
const EMIT = /\.emit(?:AndWait)?\(\s*event_types\.([A-Z][A-Z0-9_]*)\b/g;

describe('event types', () => {
    test('every one the app or its tests names is declared', () => {
        const undeclared = [];
        for (const file of [...new Set(appFiles), ...testFiles]) {
            for (const [, name] of fs.readFileSync(file, 'utf8').matchAll(REFERENCE)) {
                if (!declared.has(name)) undeclared.push(`${path.relative(root, file)}: ${name}`);
            }
        }
        expect(undeclared).toEqual([]);
    });

    test('every declared one is used by the app other than to emit it', () => {
        /** @type {Map<string, number>} */
        const uses = new Map();
        const eventsFile = path.join(root, 'public/scripts/events.js');
        for (const file of new Set(appFiles)) {
            if (file === eventsFile) continue;
            const text = fs.readFileSync(file, 'utf8');
            for (const [, name] of text.matchAll(REFERENCE)) uses.set(name, (uses.get(name) ?? 0) + 1);
            for (const [, name] of text.matchAll(EMIT)) uses.set(name, (uses.get(name) ?? 0) - 1);
        }
        expect([...declared].filter(name => !(uses.get(name) > 0))).toEqual([]);
    });
});
