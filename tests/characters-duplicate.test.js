import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';
import { Buffer } from 'node:buffer';

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
        const hugeDigitName = `Ghost_${'9'.repeat(24)}.png`;
        await writeTestCharacter(hugeDigitName);

        const first = await duplicate(hugeDigitName);
        expect(first.status).toBe(200);
        const firstBody = await first.json();
        expect(firstBody.path).toBe(`${hugeDigitName.replace('.png', '')}_1.png`);

        const second = await duplicate(hugeDigitName);
        expect(second.status).toBe(200);
        const secondBody = await second.json();
        expect(secondBody.path).toBe(`${hugeDigitName.replace('.png', '')}_2.png`);
    }, 10_000);
});
