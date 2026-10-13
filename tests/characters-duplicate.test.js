import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';
import { Buffer } from 'node:buffer';

// A minimal valid 1x1 transparent PNG - just enough of a real PNG for png-chunks-extract to parse, so
// character-card-parser.js's write()/read() can attach and later re-read a `chara` tEXt chunk on it.
const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

/** @type {import('../src/character-card-parser.js').write} */
let writeCard;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/library-codes.js').TYPE} */
let TYPE;
/** @type {import('express').Router} */
let router;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/**
 * Mounts the real characters.js router behind a fake auth middleware, same pattern as
 * characters-query.test.js - the middleware reads `directories` from this file's outer-scope `let` at
 * request time, so beforeEach can point every test at a fresh temp directory.
 *
 * Regression coverage for the /duplicate wedge bug (docs/design/character-data-residency-redesign.md
 * §9, phase 0c): a `_<digits>` suffix that's long enough to exceed Number.MAX_SAFE_INTEGER used to make
 * `suffix++` stop advancing in float precision, so the collision loop spun forever on a synchronous
 * `existsSync`. See src/endpoints/characters.js's `/duplicate` handler for the fix (a length-capped
 * regex plus an iteration-count guard).
 */
beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    ({ write: writeCard } = await import('../src/character-card-parser.js'));
    fixture = await import('./converted-user.fixture.js');
    ({ TYPE } = await import('../src/library-codes.js'));

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-characters-duplicate-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/**
 * Writes a card PNG to `directories.characters/<name>` and its row; the row is what makes the character exist.
 */
async function writeTestCharacter(name, data = { name: 'Ghost', spec: 'chara_card_v2' }) {
    const buffer = writeCard(BLANK_PNG, JSON.stringify(data));
    await fixture.writeCardWithImage(user, name, JSON.stringify(data), buffer);
}

async function duplicate(avatarUrl) {
    return fetch(`${baseUrl}/api/characters/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_url: avatarUrl }),
    });
}

describe('/api/characters/duplicate', () => {
    test('increments a plain numeric suffix', async () => {
        await writeTestCharacter('Ghost_1.png');

        const response = await duplicate('Ghost_1.png');
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.path).toBe('Ghost_2.png');
        expect(await user.store.lib.entity(TYPE.character, 'Ghost_2.png')).not.toBeNull();
    });

    test('does not wedge on a suffix long enough to lose float precision', async () => {
        // 24 nines: well past Number.MAX_SAFE_INTEGER (16 digits). Before the fix, the second duplicate
        // of this file would collide with a `_1e+22`-style filename produced by the first and spin
        // forever incrementing a suffix stuck in float precision.
        const hugeDigitName = `Ghost_${'9'.repeat(24)}.png`;
        await writeTestCharacter(hugeDigitName);

        const first = await duplicate(hugeDigitName);
        expect(first.status).toBe(200);
        const firstBody = await first.json();
        // The digit run is too long to be treated as a suffix at all (regex caps at 15 digits), so the
        // whole original name is kept literal and a small, safe suffix is appended.
        expect(firstBody.path).toBe(`${hugeDigitName.replace('.png', '')}_1.png`);

        // Duplicating the *original* file again must also terminate quickly rather than colliding with
        // whatever the first duplicate produced and spinning.
        const second = await duplicate(hugeDigitName);
        expect(second.status).toBe(200);
        const secondBody = await second.json();
        expect(secondBody.path).toBe(`${hugeDigitName.replace('.png', '')}_2.png`);
    }, 10_000);
});
