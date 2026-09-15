import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    registerServerTool,
    unregisterServerTool,
    getRegisteredServerTools,
    getEnabledServerTools,
    toOpenAIToolSchema,
} from './server-tools.js';

// plugin-loader.js reads `enableServerPlugins`/`enableServerPluginsAutoUpdate` from config at
// *module import time* (see its top-level `const enableServerPlugins = ...`). `getConfigValue()`
// checks a `SILLYTAVERN_<KEY>` environment variable before ever touching the config file/
// `setConfigFilePath()` (see src/util.js's `_getValue()`), so setting these env vars before
// importing plugin-loader.js lets this test call the real `loadPlugins()` without a config.yaml
// on disk at all, and confirms the enableServerPlugins gate is enforced by the *caller*
// (server-main.js checks it before ever calling loadPlugins() in production) rather than inside
// loadPlugins() itself - loadPlugins() has no gate of its own beyond this same config value.
process.env.SILLYTAVERN_ENABLESERVERPLUGINS = 'true';
process.env.SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE = 'false';
const { loadPlugins } = await import('./plugin-loader.js');

const noopInvoke = async () => 'ok';

function makeTool(overrides = {}) {
    return {
        id: 'test-plugin:tool',
        name: 'test_tool',
        description: 'A test tool.',
        parameters: { type: 'object', properties: {} },
        invoke: noopInvoke,
        ...overrides,
    };
}

/**
 * Removes every id from the registry, so each test section starts from a clean slate regardless of
 * what earlier sections registered. `server-tools.js` keeps its registry as process-wide module
 * state (by design - it's a singleton registry), so tests in the same process must clean up after
 * themselves.
 * @param {string[]} ids Ids to unregister.
 */
function cleanup(ids) {
    for (const id of ids) {
        unregisterServerTool(id);
    }
}

async function run() {
    // --- Basic registration + getRegisteredServerTools()/toOpenAIToolSchema() round-trip ---
    {
        const tool = makeTool();
        registerServerTool(tool);
        try {
            const registered = getRegisteredServerTools();
            const found = registered.find(t => t.id === tool.id);
            assert.ok(found, 'registered tool appears in getRegisteredServerTools()');
            assert.equal(found.name, tool.name);
            assert.equal(found.description, tool.description);
            assert.deepEqual(found.parameters, tool.parameters);

            const schema = toOpenAIToolSchema(found);
            assert.deepEqual(schema, {
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                },
            }, 'toOpenAIToolSchema() produces the exact OpenAI wire shape');
        } finally {
            cleanup([tool.id]);
        }
    }

    // --- id collision throws ---
    {
        const tool = makeTool({ id: 'dup:id', name: 'dup_name_a' });
        registerServerTool(tool);
        try {
            assert.throws(
                () => registerServerTool(makeTool({ id: 'dup:id', name: 'dup_name_b' })),
                /already registered/,
                'registering a duplicate id throws',
            );
        } finally {
            cleanup([tool.id]);
        }
    }

    // --- name collision across different ids throws ---
    {
        const first = makeTool({ id: 'plugin-a:tool', name: 'shared_name' });
        registerServerTool(first);
        try {
            assert.throws(
                () => registerServerTool(makeTool({ id: 'plugin-b:tool', name: 'shared_name' })),
                /already registered/,
                'registering a duplicate name under a different id throws',
            );
        } finally {
            cleanup([first.id]);
        }
    }

    // --- Missing/invalid required fields throw, one assertion per field ---
    {
        assert.throws(() => registerServerTool(makeTool({ id: '' })), /"id"/, 'empty id throws');
        assert.throws(() => registerServerTool(makeTool({ id: undefined })), /"id"/, 'missing id throws');
        assert.throws(() => registerServerTool(makeTool({ id: 123 })), /"id"/, 'non-string id throws');

        assert.throws(() => registerServerTool(makeTool({ name: '' })), /"name"/, 'empty name throws');
        assert.throws(() => registerServerTool(makeTool({ name: undefined })), /"name"/, 'missing name throws');

        assert.throws(() => registerServerTool(makeTool({ description: '' })), /"description"/, 'empty description throws');
        assert.throws(() => registerServerTool(makeTool({ description: undefined })), /"description"/, 'missing description throws');

        assert.throws(() => registerServerTool(makeTool({ parameters: undefined })), /"parameters"/, 'missing parameters throws');
        assert.throws(() => registerServerTool(makeTool({ parameters: null })), /"parameters"/, 'null parameters throws');
        assert.throws(() => registerServerTool(makeTool({ parameters: [] })), /"parameters"/, 'array parameters throws');
        assert.throws(() => registerServerTool(makeTool({ parameters: 'nope' })), /"parameters"/, 'string parameters throws');

        assert.throws(() => registerServerTool(makeTool({ invoke: undefined })), /"invoke"/, 'missing invoke throws');
        assert.throws(() => registerServerTool(makeTool({ invoke: 'nope' })), /"invoke"/, 'non-function invoke throws');

        assert.throws(() => registerServerTool(makeTool({ shouldEnable: 'nope' })), /"shouldEnable"/, 'non-function shouldEnable throws');

        // None of the above should have left anything registered.
        assert.equal(getRegisteredServerTools().some(t => t.id === 'test-plugin:tool'), false, 'no partial registration survives a validation failure');
    }

    // --- unregisterServerTool() removes it, and the id can be re-registered ---
    {
        const tool = makeTool();
        registerServerTool(tool);
        unregisterServerTool(tool.id);
        assert.equal(getRegisteredServerTools().some(t => t.id === tool.id), false, 'unregistered tool no longer listed');

        // Re-registering with the same id (and same name) now succeeds again.
        registerServerTool(tool);
        try {
            assert.ok(getRegisteredServerTools().some(t => t.id === tool.id), 'id can be re-registered after unregistering');
        } finally {
            cleanup([tool.id]);
        }

        // unregistering an id that was never registered is a harmless no-op.
        assert.doesNotThrow(() => unregisterServerTool('never-registered:id'));
    }

    // --- getEnabledServerTools(ctx) filtering ---
    {
        const always = makeTool({ id: 'enable-test:always', name: 'always_on' });
        const disabled = makeTool({ id: 'enable-test:disabled', name: 'always_off', shouldEnable: async () => false });
        const enabled = makeTool({ id: 'enable-test:enabled', name: 'conditionally_on', shouldEnable: async () => true });

        let receivedCtx;
        const ctxAware = makeTool({
            id: 'enable-test:ctx-aware',
            name: 'ctx_aware',
            shouldEnable: async (ctx) => {
                receivedCtx = ctx;
                return ctx?.flag === true;
            },
        });

        registerServerTool(always);
        registerServerTool(disabled);
        registerServerTool(enabled);
        registerServerTool(ctxAware);

        try {
            const ctx = { flag: true, marker: 'abc' };
            const result = await getEnabledServerTools(ctx);
            const resultIds = result.map(t => t.id);

            assert.ok(resultIds.includes(always.id), 'a tool with no shouldEnable is always included');
            assert.ok(!resultIds.includes(disabled.id), 'a tool whose shouldEnable returns false is excluded');
            assert.ok(resultIds.includes(enabled.id), 'a tool whose shouldEnable returns true is included');
            assert.ok(resultIds.includes(ctxAware.id), 'a tool whose shouldEnable(ctx) evaluates the given ctx and returns true is included');
            assert.deepEqual(receivedCtx, ctx, 'shouldEnable actually receives the exact ctx passed to getEnabledServerTools');

            const flagFalseResult = await getEnabledServerTools({ flag: false });
            assert.ok(!flagFalseResult.map(t => t.id).includes(ctxAware.id), 'shouldEnable is re-evaluated per call and reacts to a different ctx');
        } finally {
            cleanup([always.id, disabled.id, enabled.id, ctxAware.id]);
        }
    }

    // --- End-to-end: a real plugin file, loaded through the real loadPlugins() loader from a
    // temp fixture directory (never touching the real gitignored plugins/ directory), registers
    // and unregisters a tool via this module. This also verifies loadPlugins() does not itself
    // gate on the enableServerPlugins config value - that gate is the caller's (server-main.js's)
    // responsibility, not plugin-loader.js's, since we call loadPlugins() directly here with no
    // config file present at all and it still runs the plugin.
    {
        const serverToolsPath = new URL('./server-tools.js', import.meta.url).pathname;
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-server-tools-plugin-fixture-'));
        const pluginDir = path.join(fixtureRoot, 'example-server-tool');
        fs.mkdirSync(pluginDir, { recursive: true });

        const pluginSource = `
import { registerServerTool, unregisterServerTool } from ${JSON.stringify(serverToolsPath)};

export const info = {
    id: 'example-server-tool-fixture',
    name: 'Example Server Tool (test fixture)',
    description: 'A minimal fixture plugin proving the server-tools registration path end-to-end.',
};

const TOOL_ID = 'example-server-tool-fixture:add';

export async function init(_router) {
    registerServerTool({
        id: TOOL_ID,
        name: 'add',
        description: 'Adds two numbers together.',
        parameters: {
            type: 'object',
            properties: {
                a: { type: 'number' },
                b: { type: 'number' },
            },
            required: ['a', 'b'],
        },
        invoke: async (args) => (Number(args.a) + Number(args.b)),
    });
}

export async function exit() {
    unregisterServerTool(TOOL_ID);
}
`;
        fs.writeFileSync(path.join(pluginDir, 'index.mjs'), pluginSource);

        // Minimal fake Express app - loadPlugins() only calls app.use() when the plugin's router
        // actually registered routes, which this fixture plugin never does.
        const fakeApp = { use: () => { } };

        const cleanupFn = await loadPlugins(fakeApp, fixtureRoot);
        try {
            const registered = getRegisteredServerTools().find(t => t.id === 'example-server-tool-fixture:add');
            assert.ok(registered, 'loadPlugins() loaded the fixture plugin and it successfully called registerServerTool()');
            assert.equal(registered.name, 'add');

            const invokeResult = await registered.invoke({ a: 2, b: 3 });
            assert.equal(invokeResult, 5, 'the registered tool\'s invoke() actually runs and produces the expected result');

            const schema = toOpenAIToolSchema(registered);
            assert.equal(schema.function.name, 'add');
        } finally {
            await cleanupFn();
            fs.rmSync(fixtureRoot, { recursive: true, force: true });
        }

        assert.equal(
            getRegisteredServerTools().some(t => t.id === 'example-server-tool-fixture:add'),
            false,
            'the fixture plugin\'s exit() correctly unregistered its tool via unregisterServerTool()',
        );
    }

    console.log('server-tools.test.js: all assertions passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
