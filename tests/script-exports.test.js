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
const COPIED = ['.githooks', 'scripts/script-exports.mjs', 'package.json', 'tsconfig.precommit.json', '.oxlintrc.json'];
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
        git(repo, 'add', '.upstream-script-exports');
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
        expect(merged.output).toContain(`wrote .upstream-script-exports from the expected commit (${u1})`);
        expect(git(repo, 'diff', '--cached', '--name-only')).toContain('.upstream-script-exports');
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
        git(repo, 'add', '.upstream-script-exports');
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
        git(fixture.repo, 'add', '.upstream-script-exports');
        const result = hooked(fixture.repo, 'commit', '-q', '-m', 'list at one base');
        expect(result.status).toBe(0);
    }, TIMEOUT);

    test('an export only the other base has must stay', () => {
        const { repo, a1, b1 } = crissCrossRepo();
        expect(checker(repo, 'refresh', a1).status).toBe(0);
        git(repo, 'add', '.upstream-script-exports');
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
