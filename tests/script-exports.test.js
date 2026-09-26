// Drives scripts/script-exports.mjs and the .githooks that call it through real git commands, in
// throwaway repos under the OS temp dir. Each repo gets copies of this checkout's hooks, checker,
// package.json and pre-commit configs, a symlink to its node_modules, and a synthetic
// public/script.js. upstream/staging is set with update-ref; nothing is fetched from a real remote.

import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPIED = ['.githooks', 'scripts/script-exports.mjs', 'scripts/script-signatures.mjs', 'package.json', 'tsconfig.precommit.json', '.oxlintrc.json'];
const TIMEOUT = 120_000;

// A clean git environment: no inherited hook state (GIT_DIR, GIT_INDEX_FILE, ...) and no user or
// system config, so only what each repo sets applies.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
Object.assign(ENV, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
});

const tempDirs = [];

beforeAll(() => {
    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
        throw new Error(`${ROOT}/node_modules does not exist; the hooks need it (run npm install).`);
    }
});

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `st-script-exports-${name}-`));
    tempDirs.push(dir);
    return dir;
}

function run(cwd, command, args) {
    const result = spawnSync(command, args, { cwd, env: ENV, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
}

/** Runs git with the repo's hooks, returning status and output. */
function hooked(repo, ...args) {
    return run(repo, 'git', ['-c', `core.hooksPath=${path.join(repo, '.githooks')}`, ...args]);
}

/** Runs git without hooks, for building fixtures; throws on failure. */
function git(repo, ...args) {
    const result = run(repo, 'git', ['-c', 'core.hooksPath=/dev/null', ...args]);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.output}`);
    return result.stdout.trim();
}

function checker(repo, ...args) {
    return run(repo, 'node', ['scripts/script-exports.mjs', ...args]);
}

function npm(repo, script, ...args) {
    return run(repo, 'npm', ['run', '--silent', script, ...(args.length ? ['--', ...args] : [])]);
}

function exportsSource(names) {
    return names.map(name => `export function ${name}() {}\n`).join('');
}

function writeScript(repo, names) {
    fs.writeFileSync(path.join(repo, 'public/script.js'), exportsSource(names));
}

function commitAll(repo, message) {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
}

function listCommit(repo) {
    return fs.readFileSync(path.join(repo, '.upstream-script-exports'), 'utf8').split('\n')[0];
}

function stageRecords(repo) {
    git(repo, 'add', '.upstream-script-exports', '.upstream-script-signatures');
}

function setUpstream(repo, commit) {
    git(repo, 'update-ref', 'refs/remotes/upstream/staging', commit);
}

/** Copies this checkout's tooling into `dir` and makes `dir` a git repo on branch `ours`. */
function initRepo(dir) {
    git(dir, 'init', '-q', '-b', 'ours');
    installTooling(dir);
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
}

function installTooling(dir) {
    for (const file of COPIED) {
        fs.cpSync(path.join(ROOT, file), path.join(dir, file), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, '.oxlint-cycle-baseline'), '0\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
}

/**
 * U0 exports a and b. `ours` branches from U0 with the list refreshed at U0 and an extra export.
 * U1 (adds c) and U2 (adds e) follow U0 on upstream. upstream/staging starts at U1.
 */
function linearRepo() {
    const repo = tempDir('linear');
    initRepo(repo);
    writeScript(repo, ['a', 'b']);
    const u0 = commitAll(repo, 'U0');
    setUpstream(repo, u0);
    const refreshed = checker(repo, 'refresh');
    if (refreshed.status !== 0) throw new Error(refreshed.output);
    // Distinct lines from upstream's additions, so the merges below are clean.
    writeScript(repo, ['extra', 'a', 'b']);
    commitAll(repo, 'ours');
    git(repo, 'checkout', '-q', '-b', 'up', u0);
    writeScript(repo, ['a', 'b', 'c']);
    const u1 = commitAll(repo, 'U1 adds c');
    writeScript(repo, ['a', 'b', 'c', 'e']);
    const u2 = commitAll(repo, 'U2 adds e');
    git(repo, 'checkout', '-q', 'ours');
    setUpstream(repo, u1);
    return { repo, u0, u1, u2 };
}

function touch(repo, name) {
    fs.appendFileSync(path.join(repo, name), 'x\n');
    git(repo, 'add', name);
}

function dropExport(repo, name) {
    const file = path.join(repo, 'public/script.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`export function ${name}(`, `function ${name}(`));
    git(repo, 'add', 'public/script.js');
}

describe('script-exports: normal commit', () => {
    test('passes with an up-to-date list', () => {
        const { repo } = linearRepo();
        touch(repo, 'note.txt');
        const result = hooked(repo, 'commit', '-q', '-m', 'normal');
        expect(result.status).toBe(0);
    }, TIMEOUT);

    test('blocks a list refreshed ahead of what the commit contains', () => {
        const { repo, u0, u1 } = linearRepo();
        expect(checker(repo, 'refresh', u1).status).toBe(0);
        stageRecords(repo);
        const result = hooked(repo, 'commit', '-q', '-m', 'ahead');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`records ${u1}, which this commit does not contain`);
        expect(result.stderr).toContain(`the newest upstream/staging commit it contains is ${u0}`);
    }, TIMEOUT);

    test('blocks dropping an upstream export', () => {
        const { repo } = linearRepo();
        dropExport(repo, 'b');
        const result = hooked(repo, 'commit', '-q', '-m', 'drop b');
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/no longer exports 1 name\(s\)[\s\S]*\n {2}b\n/);
        expect(result.stderr).toContain('pre-commit: blocked -- script.js export parity failed');
    }, TIMEOUT);
});

describe('script-exports: npm run merge:upstream', () => {
    test('merges with the list refreshed and staged, and the merge commits', () => {
        const { repo, u1 } = linearRepo();
        const merged = npm(repo, 'merge:upstream');
        expect(merged.status).toBe(0);
        expect(merged.output).toContain(`wrote .upstream-script-exports and .upstream-script-signatures from the expected commit (${u1})`);
        expect(git(repo, 'diff', '--cached', '--name-only')).toContain('.upstream-script-exports');
        expect(git(repo, 'diff', '--cached', '--name-only')).toContain('.upstream-script-signatures');
        const committed = hooked(repo, 'commit', '-q', '--no-edit');
        expect(committed.status).toBe(0);
        expect(git(repo, 'rev-parse', 'HEAD^2')).toBe(u1);
        expect(listCommit(repo)).toBe(u1);
    }, TIMEOUT);
});

describe('script-exports: clean merge, then a commit', () => {
    test('post-merge warns, the next commit is blocked until the list is refreshed', () => {
        const { repo, u1, u2 } = linearRepo();
        expect(npm(repo, 'merge:upstream').status).toBe(0);
        expect(hooked(repo, 'commit', '-q', '--no-edit').status).toBe(0);
        setUpstream(repo, u2);

        const merged = hooked(repo, 'merge', '-q', '--no-edit', 'upstream/staging');
        expect(merged.status).toBe(0);
        expect(git(repo, 'rev-parse', 'HEAD^2')).toBe(u2);
        expect(merged.stderr).toContain('script-exports: WARNING - this merge moved the newest upstream/staging commits');
        expect(merged.stderr).toContain(`now ${u2}`);

        touch(repo, 'note.txt');
        const blocked = hooked(repo, 'commit', '-q', '-m', 'next');
        expect(blocked.status).toBe(1);
        expect(blocked.stderr).toContain(`refresh .upstream-script-exports: it records ${u1}, but the newest upstream/staging commit it contains is ${u2}`);

        expect(npm(repo, 'script-exports:refresh').status).toBe(0);
        stageRecords(repo);
        const refreshed = hooked(repo, 'commit', '-q', '-m', 'refreshed');
        expect(refreshed.status).toBe(0);
        expect(listCommit(repo)).toBe(u2);
    }, TIMEOUT);

    test('pre-merge-commit blocks a clean merge that drops an upstream export', () => {
        const { repo } = linearRepo();
        const tip = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'checkout', '-q', '-b', 'feat');
        dropExport(repo, 'b');
        git(repo, 'commit', '-q', '-m', 'feat drops b');
        git(repo, 'checkout', '-q', 'ours');

        const result = hooked(repo, 'merge', '-q', '--no-ff', '--no-edit', 'feat');
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('pre-merge-commit: blocked -- script.js export parity failed');
        expect(git(repo, 'rev-parse', 'HEAD')).toBe(tip);
        git(repo, 'merge', '--abort');
    }, TIMEOUT);
});

describe('script-exports: several merge-bases', () => {
    /**
     * Criss-cross: A1 (upstream, adds p) and B1 (ours, adds q) both branch from U0, then each side
     * merges the other, so upstream/staging and ours have two independent merge-bases.
     */
    function crissCrossRepo() {
        const repo = tempDir('criss-cross');
        initRepo(repo);
        writeScript(repo, ['a']);
        const u0 = commitAll(repo, 'U0');
        setUpstream(repo, u0);
        expect(checker(repo, 'refresh').status).toBe(0);
        const base = commitAll(repo, 'list at U0');
        git(repo, 'checkout', '-q', '-b', 'up', base);
        writeScript(repo, ['a', 'p']);
        const a1 = commitAll(repo, 'A1 adds p');
        git(repo, 'checkout', '-q', 'ours');
        writeScript(repo, ['q', 'a']);
        const b1 = commitAll(repo, 'B1 adds q');
        git(repo, 'merge', '-q', '--no-edit', a1);
        git(repo, 'checkout', '-q', 'up');
        git(repo, 'merge', '-q', '--no-edit', b1);
        git(repo, 'checkout', '-q', 'ours');
        setUpstream(repo, 'up');
        const bases = git(repo, 'merge-base', '--all', 'upstream/staging', 'HEAD').split('\n').sort();
        expect(bases).toEqual([a1, b1].sort());
        return { repo, u0, a1, b1 };
    }

    test('refresh without a ref asks which base to use', () => {
        const { repo, a1, b1 } = crissCrossRepo();
        const result = checker(repo, 'refresh');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('(criss-cross history); pass the one to take the list from.');
        expect(result.stderr).toContain(a1);
        expect(result.stderr).toContain(b1);
    }, TIMEOUT);

    test.each([['A1', 'a1'], ['B1', 'b1']])('a list at %s commits', (_label, key) => {
        const fixture = crissCrossRepo();
        expect(checker(fixture.repo, 'refresh', fixture[key]).status).toBe(0);
        stageRecords(fixture.repo);
        const result = hooked(fixture.repo, 'commit', '-q', '-m', 'list at one base');
        expect(result.status).toBe(0);
    }, TIMEOUT);

    test('an export only the other base has must stay', () => {
        const { repo, a1, b1 } = crissCrossRepo();
        expect(checker(repo, 'refresh', a1).status).toBe(0);
        stageRecords(repo);
        dropExport(repo, 'q');
        const result = hooked(repo, 'commit', '-q', '-m', 'drop q');
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(new RegExp(`does not export 1 name\\(s\\) that upstream/staging ${b1} \\(also contained in this commit\\) exports:\\n {2}q\\n`));
    }, TIMEOUT);

    test('a list behind both bases is blocked', () => {
        const { repo, u0 } = crissCrossRepo();
        touch(repo, 'note.txt');
        expect(listCommit(repo)).toBe(u0);
        const result = hooked(repo, 'commit', '-q', '-m', 'lagging');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`refresh .upstream-script-exports: it records ${u0}, but the newest upstream/staging commits it contains are`);
    }, TIMEOUT);
});

const SKIP_NOTICE = /script-exports: notice - .*, so whether \.upstream-script-exports is up to date was not checked\./;

describe('script-exports: no upstream/staging ref', () => {
    test('skips the staleness part with a notice and still runs parity', () => {
        const { repo } = linearRepo();
        git(repo, 'update-ref', '-d', 'refs/remotes/upstream/staging');

        touch(repo, 'note.txt');
        const passed = hooked(repo, 'commit', '-q', '-m', 'no ref');
        expect(passed.status).toBe(0);
        expect(passed.stderr).toContain('script-exports: notice - upstream/staging does not resolve here');
        expect(passed.stderr).toMatch(SKIP_NOTICE);

        dropExport(repo, 'b');
        const blocked = hooked(repo, 'commit', '-q', '-m', 'no ref, drop b');
        expect(blocked.status).toBe(1);
        expect(blocked.stderr).toMatch(SKIP_NOTICE);
        expect(blocked.stderr).toMatch(/no longer exports 1 name\(s\)[\s\S]*\n {2}b\n/);

        const refresh = checker(repo, 'refresh');
        expect(refresh.status).toBe(1);
        expect(refresh.stderr).toContain('upstream/staging does not resolve here; pass the ref to take the list from.');
    }, TIMEOUT);
});

describe('script-exports: shallow clone with no merge-base', () => {
    test('skips the staleness part with a notice and still runs parity', () => {
        const { repo: source } = linearRepo();
        const repo = path.join(tempDir('shallow'), 'clone');
        const cloned = run(path.dirname(repo), 'git', ['-c', 'core.hooksPath=/dev/null', 'clone', '-q', '--depth', '1', '--no-single-branch', '--branch', 'ours', `file://${source}`, repo]);
        expect(cloned.status).toBe(0);
        fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(repo, 'node_modules'));
        setUpstream(repo, 'origin/up');
        expect(git(repo, 'rev-parse', '--is-shallow-repository')).toBe('true');
        expect(run(repo, 'git', ['merge-base', 'HEAD', 'upstream/staging']).status).toBe(1);

        touch(repo, 'note.txt');
        const passed = hooked(repo, 'commit', '-q', '-m', 'shallow');
        expect(passed.status).toBe(0);
        expect(passed.stderr).toContain('script-exports: notice - upstream/staging has no merge-base with HEAD here');
        expect(passed.stderr).toMatch(SKIP_NOTICE);

        dropExport(repo, 'b');
        const blocked = hooked(repo, 'commit', '-q', '-m', 'shallow, drop b');
        expect(blocked.status).toBe(1);
        expect(blocked.stderr).toMatch(SKIP_NOTICE);
        expect(blocked.stderr).toMatch(/no longer exports 1 name\(s\)[\s\S]*\n {2}b\n/);
    }, TIMEOUT);
});

describe('script-exports: signatures', () => {
    const UPSTREAM_FILES = {
        'public/scripts/utils.js': [
            'export function debounce(func, timeout) { return (...args) => { setTimeout(() => func(...args), timeout); }; }',
            'export function debounceAsync(func, timeout) { return (...args) => Promise.resolve(func(...args)); }',
            'export function throttle(func, limit) { return (...args) => { func(...args); }; }',
            'export function debouncedThrottle(func, limit) { return function () { func(...arguments); }; }',
        ].join('\n'),
        'public/scripts/PromptManager.js': [
            'function debouncePromise(func, delay) { return (...args) => Promise.resolve(func(...args)); }',
            'export const promised = debouncePromise((q) => q, 1);',
        ].join('\n'),
        'public/scripts/mutex.js': 'export class Mutex { async update(...args) {} }\n',
        'public/scripts/lib.js': 'export function reexported(z) {}\n',
    };

    const UPSTREAM_SCRIPT = `import { debounce, debounceAsync, throttle, debouncedThrottle } from './scripts/utils.js';
import { promised } from './scripts/PromptManager.js';
import { Mutex } from './scripts/mutex.js';
import { reexported } from './scripts/lib.js';

export function plain(a, b) {}
/** @param {string} [c] */
export function withJsdoc(a, c) {}
export function withDefault(a, b = 1) {}
export async function asyncFn(a) {}
export function restFn(a, ...rest) {}
/**
 * @param {object} options
 * @param {boolean} [options.flag]
 */
export function destructured({ flag, loader: showLoader, mode = 'x' } = {}) {}
export function noJsdocDestructured({ x }) {}
export function arrayParam([a, b]) {}
export const arrow = (a, b = 2) => a;
export const asyncArrow = async (a) => a;
export const debounced = debounce((a, b = 0) => {}, 10);
export const debouncedAsync = debounceAsync(function (a) {}, 10);
function namedTarget(t) {}
export const throttled = throttle(namedTarget, 10);
export const dthrottled = debouncedThrottle(() => {}, 10);
const someValue = 1;
export const notFn = debounce(someValue, 10);
function myDebounce(f) { return f; }
export const localDebounce = myDebounce(() => {}, 1);
export const mutex = new Mutex();
export const bound = mutex.update.bind(mutex);
export const boundArgs = plain.bind(null, 1);
export const otherCall = $('#x');
export const created = new Map();
export let uninit;
export const alias = plain;
const CONST = 'x';
export const valueAlias = CONST;
const obj = { x: 1 };
export const prop = obj.x;
export const num = 5;
export const str = 'x';
export { promised, reexported };
`;

    const EXPECTED = [
        'alias fn a b',
        'arrayParam fn []',
        'arrow fn a b?',
        'asyncArrow async a',
        'asyncFn async a',
        'bound async ...args',
        'boundArgs fn b',
        'created opaque',
        'debounced fn a b?',
        'debouncedAsync async a',
        'destructured fn options{flag?,loader,mode?}?',
        'dthrottled fn',
        'localDebounce opaque',
        'mutex opaque',
        'noJsdocDestructured fn _{x}',
        'notFn opaque',
        'num value',
        'otherCall opaque',
        'plain fn a b',
        'promised async q',
        'prop opaque',
        'reexported fn z',
        'restFn fn a ...rest',
        'str value',
        'throttled fn t',
        'uninit opaque',
        'valueAlias value',
        'withDefault fn a b?',
        'withJsdoc fn a c?',
    ];

    /** A repo whose upstream U0 has UPSTREAM_SCRIPT, with both records refreshed at U0. */
    function signatureRepo() {
        const repo = tempDir('signatures');
        initRepo(repo);
        for (const [file, text] of Object.entries(UPSTREAM_FILES)) {
            fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
            fs.writeFileSync(path.join(repo, file), text);
        }
        fs.writeFileSync(path.join(repo, 'public/script.js'), UPSTREAM_SCRIPT);
        const u0 = commitAll(repo, 'U0');
        setUpstream(repo, u0);
        const refreshed = checker(repo, 'refresh');
        if (refreshed.status !== 0) throw new Error(refreshed.output);
        commitAll(repo, 'records');
        return { repo, u0 };
    }

    function edit(repo, file, from, to) {
        const full = path.join(repo, file);
        const text = fs.readFileSync(full, 'utf8');
        if (!text.includes(from)) throw new Error(`${file} does not contain ${from}`);
        fs.writeFileSync(full, text.replace(from, to));
    }

    function readRecord(repo) {
        return fs.readFileSync(path.join(repo, '.upstream-script-signatures'), 'utf8');
    }

    test('refresh records every form in the notation', () => {
        const { repo, u0 } = signatureRepo();
        expect(readRecord(repo)).toBe(`${u0}\n${EXPECTED.join('\n')}\n`);
        const result = checker(repo, 'check');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('with compatible signatures');
    }, TIMEOUT);

    const FAILS = [
        ['a value turned callable', 'export const num = 5;', 'export const num = () => 5;', 'num: upstream exports a value; ours is callable.'],
        ['a function turned into a value', 'export function plain(a, b) {}', 'export const plain = 1;', 'plain: upstream exports a function; ours is not callable.'],
        ['a function turned into an opaque call result', 'export function plain(a, b) {}', 'export const plain = makePlain();', 'plain: upstream exports a function; ours can\'t be proven callable.'],
        ['a function bound with let', 'export const arrow = (a, b = 2) => a;', 'export let arrow = (a, b = 2) => a;', 'arrow: upstream exports a function; ours can\'t be proven callable.'],
        ['an unresolvable .bind', 'export const boundArgs = plain.bind(null, 1);', 'export const boundArgs = missing.bind(null, 1);', 'boundArgs: upstream exports a function; ours can\'t be proven callable.'],
        ['async turned sync', 'export async function asyncFn(a) {}', 'export function asyncFn(a) {}', 'asyncFn: upstream\'s is async; ours is sync.'],
        ['fewer positional params', 'export function plain(a, b) {}', 'export function plain(a) {}', 'plain: ours has fewer positional params (1) than upstream (2).'],
        ['an optional param made required', 'export function withDefault(a, b = 1) {}', 'export function withDefault(a, b) {}', 'withDefault: param 2 `b?` is optional upstream and required in ours.'],
        ['a JSDoc-optional param made required', '/** @param {string} [c] */', '/** @param {string} c */', 'withJsdoc: param 2 `c?` is optional upstream and required in ours.'],
        ['a renamed param', 'export function plain(a, b) {}', 'export function plain(a, c) {}', 'plain: param 2 `b` is renamed to `c`.'],
        ['a rest param that drops a name', 'export function plain(a, b) {}', 'export function plain(a, ...rest) {}', 'plain: param 2 `b` is renamed to `...rest`.'],
        ['an added required param', 'export function plain(a, b) {}', 'export function plain(a, b, c) {}', 'plain: ours adds a required param 3 `c`; only optional params may be added.'],
        ['a missing destructured property', 'export function destructured({ flag, loader: showLoader, mode = \'x\' } = {}) {}', 'export function destructured({ flag, mode = \'x\' } = {}) {}', 'destructured: param 1 no longer takes the property `loader`.'],
        ['an optional destructured property made required', ' * @param {boolean} [options.flag]', ' * @param {boolean} options.flag', 'destructured: param 1\'s property `flag` is optional upstream and required in ours.'],
        ['a renamed destructured JSDoc name', ' * @param {object} options\n * @param {boolean} [options.flag]', ' * @param {object} opts\n * @param {boolean} [opts.flag]', 'destructured: param 1\'s JSDoc name `options` is `opts` in ours.'],
        ['an array param turned plain', 'export function arrayParam([a, b]) {}', 'export function arrayParam(pair) {}', 'arrayParam: param 1 `[]` is renamed to `pair`.'],
        ['a wrapped function with a renamed param', 'export const debounced = debounce((a, b = 0) => {}, 10);', 'export const debounced = debounce((a, c = 0) => {}, 10);', 'debounced: param 2 `b` is renamed to `c`.'],
        ['a computed key without a default in ours', 'export function noJsdocDestructured({ x }) {}', 'const K = Symbol("k");\nexport function noJsdocDestructured({ x, [K]: k }) {}', 'noJsdocDestructured: a computed property in a destructured param (BindingElement) is not a form the signature check handles.'],
        ['an initializer the check does not classify', 'export const num = 5;', 'export const num = someValue ? 5 : 6;', 'num: the initializer (ConditionalExpression) is not a form the signature check handles.'],
    ];

    test.each(FAILS)('fails on %s', (_label, from, to, message) => {
        const { repo } = signatureRepo();
        edit(repo, 'public/script.js', from, to);
        const result = checker(repo, 'check');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
    }, TIMEOUT);

    test('fails on a renamed param behind an import-then-export re-export', () => {
        const { repo } = signatureRepo();
        edit(repo, 'public/scripts/lib.js', 'reexported(z)', 'reexported(y)');
        const result = checker(repo, 'check');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('reexported: param 1 `z` is renamed to `y`.');
    }, TIMEOUT);

    test('fails when the two records name different commits', () => {
        const { repo, u0 } = signatureRepo();
        const other = git(repo, 'rev-parse', 'HEAD');
        edit(repo, '.upstream-script-signatures', u0, other);
        const result = checker(repo, 'check');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`records ${other} but`);
        expect(result.stderr).toContain(`records ${u0}; both must describe the same upstream commit`);
    }, TIMEOUT);

    test('fails when the signatures record is stale for its commit', () => {
        const { repo } = signatureRepo();
        edit(repo, '.upstream-script-signatures', 'plain fn a b\n', 'plain fn a b?\n');
        const result = checker(repo, 'check');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('its lines are not that commit\'s public/script.js export signatures');
    }, TIMEOUT);

    test('refresh fails on a computed key on upstream\'s side', () => {
        const { repo } = signatureRepo();
        edit(repo, 'public/script.js', 'export function noJsdocDestructured({ x }) {}', 'const K = Symbol("k");\nexport function noJsdocDestructured({ x, [K]: k = 1 }) {}');
        const head = commitAll(repo, 'computed key upstream');
        const result = checker(repo, 'refresh', head);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('noJsdocDestructured: a computed property in a destructured param (BindingElement) is not a form the signature check handles.');
    }, TIMEOUT);

    const PASSES = [
        ['a trailing extra optional param', 'export function plain(a, b) {}', 'export function plain(a, b, c = 1) {}'],
        ['a trailing extra JSDoc-optional param', 'export function plain(a, b) {}', '/** @param {number} [c] */\nexport function plain(a, b, c) {}'],
        ['extra destructured properties', 'export function destructured({ flag, loader: showLoader, mode = \'x\' } = {}) {}', 'export function destructured({ flag, loader: showLoader, mode = \'x\', extra } = {}) {}'],
        ['a rest param carrying the last optional name', 'export function withDefault(a, b = 1) {}', 'export function withDefault(a, ...b) {}'],
        ['a defaulted computed key in ours', 'export function noJsdocDestructured({ x }) {}', 'const K = Symbol("k");\nexport function noJsdocDestructured({ x, [K]: k = undefined }) {}'],
        ['a value turned opaque', 'export const num = 5;', 'export const num = compute();'],
        ['anything behind an upstream opaque', 'export const otherCall = $(\'#x\');', 'export const otherCall = 7;'],
        ['a function moved behind an import-then-export re-export', 'export function plain(a, b) {}', 'import { plain } from \'./scripts/lib.js\';\nexport { plain };'],
        ['a declaration turned into = otherName', 'export function plain(a, b) {}', 'function plainImpl(a, b) {}\nexport const plain = plainImpl;'],
    ];

    test.each(PASSES)('passes with %s', (_label, from, to) => {
        const { repo } = signatureRepo();
        edit(repo, 'public/script.js', from, to);
        if (to.startsWith('import { plain }')) {
            fs.appendFileSync(path.join(repo, 'public/scripts/lib.js'), 'export function plain(a, b) {}\n');
        }
        const result = checker(repo, 'check');
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    }, TIMEOUT);
});
