import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/user-stores.js')} */
let stores;
/** @type {typeof import('../src/library-codes.js')} */
let codes;
/** @type {string[]} */
const made = [];

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    const engine = (await import('../engine/load.js')).loadEngine().binding;
    stores = await import('../src/user-stores.js');
    codes = await import('../src/library-codes.js');
    stores.setStoreEngine(() => engine);
});

afterAll(async () => {
    await stores.closeUserStores();
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const SCRIPT = path.join('..', 'scripts', 'convert-tag-looks.mjs');
const convert = (/** @type {string} */ data) => execFileSync(process.execPath, [SCRIPT, '--data-root', data], { encoding: 'utf8' });

const REPO = path.resolve('..');

/**
 * Runs `body` in a process of its own with `lib`, the user's library, open, and closes it with the process, since a
 * closed store's files stay open in the process that had it. `body` is a module's text, with `HELPERS` in scope.
 * @param {string} data
 * @param {string} body
 * @returns {any} what `body` printed, as JSON
 */
function inOwnProcess(data, body) {
    const module = `
        import path from 'node:path';
        const { setConfigFilePath } = await import(${JSON.stringify(`${REPO}/src/util.js`)});
        setConfigFilePath(${JSON.stringify(`${REPO}/default/config.yaml`)});
        const engine = (await import(${JSON.stringify(`${REPO}/engine/load.js`)})).loadEngine().binding;
        const stores = await import(${JSON.stringify(`${REPO}/src/user-stores.js`)});
        const codes = await import(${JSON.stringify(`${REPO}/src/library-codes.js`)});
        stores.setStoreEngine(() => engine);
        const { lib } = await stores.userStore({ root: path.join(${JSON.stringify(data)}, 'u') });
        ${HELPERS}
        ${body}
        await stores.closeUserStores();
        process.exit(0);
    `;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', module], { encoding: 'utf8' }) || 'null');
}

// In the module `inOwnProcess` runs: a tag stored as an older server stored it, upstream's colors in fields of their
// own, and a tag's stored fields by field.
const HELPERS = `
    const storeOldTag = async ({ color, color2, ...tag }, look) => {
        const { id, records } = await lib.tagRecords(tag);
        const extra = Object.entries({ color, color2 }).filter(([, v]) => v !== undefined).map(([k, v]) => ({ kind: 'jsonValue', entity: id, field: codes.TAG_KEY_PREFIX + k, json: JSON.stringify(v) }));
        if (look !== undefined) extra.push({ kind: 'jsonValue', entity: id, field: codes.LOOK_FIELD, json: JSON.stringify(look) });
        await lib.store.commit([...records, ...extra]);
    };
    const storedFields = async (key) => {
        const [id] = await lib.ids(codes.TYPE.tag, [key]);
        const [entity] = await lib.entities([id]);
        return Object.fromEntries((entity?.values ?? []).map(v => [String(v.field), v.json !== undefined ? (v.json === '' ? '' : JSON.parse(v.json)) : v.text]));
    };
`;

const SET_UP = `
    await storeOldTag({ id: 'both', name: 'Both', sort_order: 1, color: 'rgba(255, 0, 0, 0.5)', color2: '#fff' });
    await storeOldTag({ id: 'text', name: 'Text', sort_order: 2, color: '', color2: 'teal' });
    await storeOldTag({ id: 'looked', name: 'Looked', sort_order: 3, color: 'red', color2: 'blue' }, { rest: [{ property: 'color', value: 'gold' }], note: 'kept' });
    await storeOldTag({ id: 'refused', name: 'Refused', sort_order: 4, color: 'red; position: fixed' });
    await storeOldTag({ id: 'plain', name: 'Plain', sort_order: 5 });
`;

const READ = `
    const fields = {};
    for (const key of ['both', 'text', 'looked', 'refused', 'plain']) fields[key] = await storedFields(key);
    console.log(JSON.stringify({ fields, tags: (await lib.tags.byIds(['both'])).tags, seq: await lib.tags.changesSeq() }));
`;

function userWithOldTags() {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tag-look-conversion-'));
    made.push(data);
    inOwnProcess(data, SET_UP);
    return data;
}

test('each tag\'s colors move into its look\'s rest layer under what the look sets, the fields go, and a second run changes nothing', () => {
    const data = userWithOldTags();

    expect(convert(data)).toBe('Users: 1. Tags looked at: 5. Tags whose colors moved into their look: 4. Colors left out as no look can hold them: 1.\n');
    const first = inOwnProcess(data, READ);
    expect(convert(data)).toBe('Users: 1. Tags looked at: 5. Tags whose colors moved into their look: 0. Colors left out as no look can hold them: 0.\n');
    const second = inOwnProcess(data, READ);

    const look = codes.LOOK_FIELD;
    expect(first.fields.both[look]).toEqual({ rest: [{ property: 'background-color', value: 'rgba(255, 0, 0, 0.5)' }, { property: 'color', value: '#fff' }] });
    expect(first.fields.text[look]).toEqual({ rest: [{ property: 'color', value: 'teal' }] });
    expect(first.fields.looked[look]).toEqual({ rest: [{ property: 'color', value: 'gold' }, { property: 'background-color', value: 'red' }], note: 'kept' });
    expect(first.fields.refused[look]).toBeUndefined();
    for (const fields of Object.values(first.fields)) {
        expect(fields).not.toHaveProperty([`${codes.TAG_KEY_PREFIX}color`]);
        expect(fields).not.toHaveProperty([`${codes.TAG_KEY_PREFIX}color2`]);
    }
    expect(first.tags).toEqual([{ id: 'both', name: 'Both', sort_order: 1, thing: expect.stringMatching(/^\d+$/) }]);
    expect(second).toEqual(first);
});

test('with a store open in another process, nothing is converted', async () => {
    const data = userWithOldTags();
    await stores.userStore({ root: path.join(data, 'u') });

    const run = spawnSync(process.execPath, [SCRIPT, '--data-root', data], { encoding: 'utf8' });

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(`A store is open in process ${process.pid}: stop the server and run this again. Nothing was converted.\n`);
    await stores.closeUserStores();
});
