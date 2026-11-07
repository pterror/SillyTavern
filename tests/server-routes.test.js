import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from '@jest/globals';
import { serverRoutes, uncalledServerRoutes } from '../scripts/server-routes.mjs';

describe('server routes', () => {
    test('are each called by the app: nothing is served for code outside this repository', () => {
        expect(uncalledServerRoutes(path.resolve(process.cwd(), '..'))).toEqual([]);
    });
});

describe('the check of server routes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-server-routes-'));
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    /** @param {Record<string, string>} tree */
    const write = (tree) => {
        fs.rmSync(root, { recursive: true, force: true });
        for (const [file, text] of Object.entries(tree)) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), text);
        }
    };
    const server = {
        'src/server-main.js': 'app.get(\'/version\', handler);\napp.use(\'/api/things\', middleware);\n',
        'src/server-startup.js': 'import { router as thingsRouter } from \'./endpoints/things.js\';\nexport function setup(app) { app.use(\'/api/things\', thingsRouter); }\n',
        'src/endpoints/things.js': [
            'import express from \'express\';',
            'export const router = express.Router();',
            'const nested = express.Router();',
            'router.post(\'/save\', handler);',
            'router.post(\'/default/set\', handler);',
            'router.get(\'/resume/:id\', handler);',
            'router.post(\'/stop/:id\', handler);',
            'nested.post(\'/props\', handler);',
            'router.use(\'/nested\', nested);',
            '',
        ].join('\n'),
    };
    const uncalled = () => uncalledServerRoutes(root).map(line => line.split('\t')[0]);

    test('the routes are the app\'s and those of the routers it mounts, nested ones included; middleware is none', () => {
        write(server);
        expect(serverRoutes(root).map(r => `${r.method} ${r.path}`).sort()).toEqual([
            'GET /api/things/resume/:id', 'GET /version', 'POST /api/things/default/set', 'POST /api/things/nested/props',
            'POST /api/things/save', 'POST /api/things/stop/:id',
        ]);
    });

    test('a route is called by its path, by a template and a string of its file, by a path its id is appended to, or by a base and a suffix', () => {
        write({
            ...server,
            'public/a.js': 'fetch(\'/version\');\nconst post = (route) => fetch(`/api/things/${route}`);\npost(\'default/set\');\n',
            'public/b.js': 'new Reader(\'/api/things/resume\');\nbegin(\'/api/things\');\nfetch(`${base}/stop/${id}`);\n',
        });
        expect(uncalled()).toEqual(['POST /api/things/nested/props', 'POST /api/things/save']);
    });

    test('tests, upstream\'s extensions, a route\'s own registration and the server\'s URLs of other servers call nothing', () => {
        write({
            ...server,
            'src/endpoints/things.test.js': 'fetch(\'/api/things/save\');\n',
            'tests/things.test.js': 'fetch(\'/api/things/save\');\n',
            'public/scripts/extensions/third-party/x/index.js': 'fetch(\'/api/things/save\');\n',
            'src/other.js': 'fetch(`${remote}/stop/1`);\n',
        });
        expect(uncalled()).toEqual([
            'GET /api/things/resume/:id', 'GET /version', 'POST /api/things/default/set', 'POST /api/things/nested/props',
            'POST /api/things/save', 'POST /api/things/stop/:id',
        ]);
    });
});
