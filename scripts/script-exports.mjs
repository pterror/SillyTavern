#!/usr/bin/env node
// Export parity for public/script.js against upstream/staging.
//
// Third-party extensions import from public/script.js, so every name upstream/staging's script.js
// exports must stay importable from ours. The checked-in list `.upstream-script-exports` (repo root)
// holds those names: its first line is the upstream/staging commit the list was taken from, then one
// export name per line, sorted.
//
// The list must be taken from the newest upstream/staging commit the commit being made contains: the
// merge-base of upstream/staging with HEAD, or with HEAD and MERGE_HEAD while a merge is being
// committed. A list that lags behind it, or records a commit ahead of it, fails. In a criss-cross
// history with several independent merge-bases, the list records one of them and script.js must
// export every name of each.
//
//   node scripts/script-exports.mjs check [--root DIR] [--repo DIR]
//       Fails unless every name in DIR/.upstream-script-exports is an export of DIR/public/script.js
//       (extra exports in ours are fine), and unless the list is exactly what `refresh` writes for
//       the --repo checkout. Without a local upstream/staging ref, or with no merge-base (a shallow
//       fetch), the second part is skipped with a notice. --root defaults to the current directory,
//       --repo to --root.
//
//   node scripts/script-exports.mjs refresh [REF]
//       Rewrites .upstream-script-exports from REF's public/script.js (default: the commit `check`
//       expects).
//
//   node scripts/script-exports.mjs merge-upstream
//       `git merge --no-commit --no-ff upstream/staging`, then, if a merge is in progress, refreshes
//       and stages the list. Exits with the merge's status.
//
//   node scripts/script-exports.mjs post-merge
//       Warns when the merge just made moved the merge-base with upstream/staging but the committed
//       list wasn't refreshed. Never fails: git ignores post-merge's exit status.
//
// There is no allowlist, exception list or inline disable. Export forms other than
// `export <function|class|var|let|const declaration>` and `export { ... }` (with or without `from`)
// fail, `export *` and `export default` included. A list that can't be read or a script.js that
// can't be parsed fails with its own message - never a silent pass.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SIGNATURES_FILE, SignatureError, compareSignature, createAnalyzer, formatSignatures, parseSignatures } from './script-signatures.mjs';

const LIST_FILE = '.upstream-script-exports';
const SCRIPT_FILE = 'public/script.js';
const UPSTREAM_REF = 'upstream/staging';

class CheckError extends Error {}

const RECORD_FILES = `${LIST_FILE} and ${SIGNATURES_FILE}`;

async function loadTypeScript() {
    let ts;
    try {
        ts = (await import('typescript')).default;
    } catch (error) {
        throw new CheckError(`could not load the 'typescript' package (${error.message}). Run 'npm install' in this repo.`);
    }
    if (typeof ts?.createSourceFile !== 'function' || !/^\d+\.\d+\.\d+/.test(String(ts.version))) {
        throw new CheckError("the 'typescript' package that loaded is not a real TypeScript build. Run 'npm install' in this repo.");
    }
    return ts;
}

function hasModifier(ts, node, kind) {
    return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some(m => m.kind === kind);
}

/**
 * Returns the sorted, de-duplicated export names of a module's source text.
 * Throws CheckError on a parse error or on any export form it doesn't handle.
 */
function exportNames(ts, sourceText, label) {
    const sourceFile = ts.createSourceFile(label, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const parseDiagnostics = sourceFile.parseDiagnostics;
    if (!Array.isArray(parseDiagnostics)) {
        throw new CheckError(`could not confirm that ${label} parsed: this TypeScript build exposes no parse diagnostics.`);
    }
    if (parseDiagnostics.length > 0) {
        const lines = parseDiagnostics.slice(0, 5).map(d => {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(d.start ?? 0);
            return `  ${label}:${line + 1}:${character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
        });
        throw new CheckError(`could not parse ${label}:\n${lines.join('\n')}`);
    }

    const names = new Set();
    const unhandled = (node, what) => {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        throw new CheckError(`${label}:${line + 1}: ${what} is not an export form this check handles. Only \`export <function|class|var|let|const declaration>\` and \`export { ... }\` are handled.`);
    };

    for (const statement of sourceFile.statements) {
        if (ts.isExportDeclaration(statement)) {
            if (statement.isTypeOnly) unhandled(statement, '`export type`');
            if (!statement.exportClause) unhandled(statement, '`export *`');
            if (!ts.isNamedExports(statement.exportClause)) unhandled(statement, '`export * as`');
            for (const element of statement.exportClause.elements) {
                if (element.isTypeOnly) unhandled(element, '`export { type ... }`');
                names.add(element.name.text);
            }
            continue;
        }
        if (ts.isExportAssignment(statement)) {
            unhandled(statement, statement.isExportEquals ? '`export =`' : '`export default`');
        }
        if (!hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) continue;
        if (hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword)) unhandled(statement, '`export default`');
        if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
            if (!statement.name) unhandled(statement, 'an unnamed exported declaration');
            names.add(statement.name.text);
        } else if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) unhandled(declaration, 'a destructuring `export const/let/var`');
                names.add(declaration.name.text);
            }
        } else {
            unhandled(statement, `an exported ${ts.SyntaxKind[statement.kind]}`);
        }
    }
    return [...names].sort(compareNames);
}

function compareNames(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function formatList(commit, names) {
    return `${commit}\n${names.join('\n')}\n`;
}

function readList(listPath) {
    let text;
    try {
        text = fs.readFileSync(listPath, 'utf8');
    } catch (error) {
        throw new CheckError(`could not read ${listPath} (${error.code ?? error.message}).`);
    }
    return parseList(text, listPath);
}

function parseList(text, listPath) {
    if (!text.endsWith('\n')) throw new CheckError(`${listPath} is malformed: it must end with a newline.`);
    const [commit, ...names] = text.slice(0, -1).split('\n');
    if (!/^[0-9a-f]{40}$/.test(commit)) {
        throw new CheckError(`${listPath} is malformed: its first line must be the full upstream/staging commit hash, got ${JSON.stringify(commit)}.`);
    }
    if (names.length === 0) throw new CheckError(`${listPath} is malformed: it lists no export names.`);
    names.forEach((name, i) => {
        if (!/^\S+$/.test(name)) throw new CheckError(`${listPath}:${i + 2} is malformed: ${JSON.stringify(name)} is not an export name.`);
        if (i > 0 && compareNames(names[i - 1], name) >= 0) {
            throw new CheckError(`${listPath}:${i + 2} is malformed: names must be sorted and unique (${JSON.stringify(names[i - 1])} then ${JSON.stringify(name)}).`);
        }
    });
    return { text, commit, names };
}

function git(repo, args, options = {}) {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function gitSucceeds(repo, args) {
    try {
        git(repo, args);
        return true;
    } catch {
        return false;
    }
}

function resolveCommit(repo, ref) {
    try {
        return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
    } catch {
        throw new CheckError(`could not resolve ${JSON.stringify(ref)} to a commit in ${repo}.`);
    }
}

function upstreamNames(ts, repo, commit) {
    let source;
    try {
        source = git(repo, ['show', `${commit}:${SCRIPT_FILE}`]);
    } catch (error) {
        throw new CheckError(`could not read ${SCRIPT_FILE} at ${commit} (${String(error.stderr ?? error.message).trim()}).`);
    }
    return exportNames(ts, source, `${commit.slice(0, 12)}:${SCRIPT_FILE}`);
}

function upstreamList(ts, repo, commit) {
    return formatList(commit, upstreamNames(ts, repo, commit));
}

function gitReader(repo, commit) {
    return (rel) => {
        try {
            return git(repo, ['show', `${commit}:${rel}`]);
        } catch (error) {
            throw new CheckError(`could not read ${rel} at ${commit} (${String(error.stderr ?? error.message).trim()}).`);
        }
    };
}

function fsReader(root) {
    return (rel) => {
        try {
            return fs.readFileSync(path.join(root, rel), 'utf8');
        } catch (error) {
            throw new CheckError(`could not read ${path.join(root, rel)} (${error.code ?? error.message}).`);
        }
    };
}

/** The signatures record `refresh` writes for `commit`. */
function upstreamSignatures(ts, repo, commit) {
    const analyzer = createAnalyzer(ts, gitReader(repo, commit), commit.slice(0, 12));
    return formatSignatures(commit, upstreamNames(ts, repo, commit).map(name => [name, analyzer.signature(name)]));
}

function readSignatures(signaturesPath) {
    let text;
    try {
        text = fs.readFileSync(signaturesPath, 'utf8');
    } catch (error) {
        throw new CheckError(`could not read ${signaturesPath} (${error.code ?? error.message}).`);
    }
    return parseSignatures(text, signaturesPath);
}

/** Problems with our signatures (`oursSignature(name)`) against upstream's `entries`, for names ours exports. */
function signatureProblems(entries, ours, oursSignature, source) {
    const problems = entries
        .filter(([name]) => ours.has(name))
        .flatMap(([name, up]) => compareSignature(name, up, oursSignature(name)));
    return problems.length === 0 ? [] : [
        `${problems.length} export(s) of ${SCRIPT_FILE} no longer match upstream's signature (${source}). Extensions call these as upstream declares them:\n`
        + problems.map(problem => `  ${problem}`).join('\n'),
    ];
}

function mergeHeads(repo) {
    const mergeHeadPath = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim());
    let text;
    try {
        text = fs.readFileSync(mergeHeadPath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw new CheckError(`could not read ${mergeHeadPath} (${error.code ?? error.message}).`);
    }
    return text.split('\n').map(line => line.trim()).filter(Boolean);
}

/**
 * The newest upstream/staging commits contained in `commits` (for several, in a merge of them):
 * `{ bases }`, the independent merge-bases (one unless the history is criss-crossed), or
 * `{ skipped }`, the reason they can't be computed here. Hooks never fetch, so a missing ref or a
 * shallow upstream fetch with no merge-base skips instead of blocking every commit.
 */
function upstreamBasesIn(repo, commits) {
    if (!gitSucceeds(repo, ['rev-parse', '--verify', '--quiet', `${UPSTREAM_REF}^{commit}`])) {
        return { skipped: `${UPSTREAM_REF} does not resolve here` };
    }
    // With more than two arguments, merge-base computes the base of the first with a hypothetical
    // merge of the rest.
    let all;
    try {
        all = git(repo, ['merge-base', '--all', UPSTREAM_REF, ...commits]).split('\n').filter(Boolean);
    } catch (error) {
        if (error.status !== 1 || String(error.stdout ?? '').trim() !== '') {
            throw new CheckError(`git merge-base ${UPSTREAM_REF} ${commits.join(' ')} failed (${String(error.stderr ?? error.message).trim()}).`);
        }
        all = [];
    }
    if (all.length === 0) {
        return { skipped: `${UPSTREAM_REF} has no merge-base with ${commits.join(' + ')} here (a shallow fetch or unrelated history)` };
    }
    const bases = all.length === 1 ? all : git(repo, ['merge-base', '--independent', ...all]).split('\n').filter(Boolean);
    return { bases };
}

function upstreamBasesOfCommit(repo) {
    return upstreamBasesIn(repo, ['HEAD', ...mergeHeads(repo)]);
}

function notice(message) {
    console.warn(`script-exports: notice - ${message}`);
}

function describeBases(bases) {
    return bases.length === 1
        ? `the newest ${UPSTREAM_REF} commit it contains is ${bases[0]}`
        : `the newest ${UPSTREAM_REF} commits it contains are ${bases.join(', ')} (criss-cross history)`;
}

function checkFreshness(ts, repo, list, listPath, signatures, signaturesPath, ours, oursSignature) {
    const result = upstreamBasesOfCommit(repo);
    if (result.skipped) {
        notice(`${result.skipped}, so whether ${LIST_FILE} is up to date was not checked.`);
        return [];
    }
    const { bases } = result;
    const fix = `Run 'npm run script-exports:refresh' and stage ${RECORD_FILES}.`;
    const problems = [];
    if (!bases.includes(list.commit)) {
        const lags = bases.some(base => gitSucceeds(repo, ['merge-base', '--is-ancestor', list.commit, base]));
        problems.push(lags
            ? `refresh ${LIST_FILE}: it records ${list.commit}, but ${describeBases(bases)}. ${fix}`
            : `${listPath} records ${list.commit}, which this commit does not contain; ${describeBases(bases)}. ${fix}`);
    } else {
        if (list.text !== upstreamList(ts, repo, list.commit)) {
            problems.push(`${listPath} records ${list.commit} but its names are not that commit's ${SCRIPT_FILE} exports. ${fix}`);
        }
        if (signatures.text !== upstreamSignatures(ts, repo, list.commit)) {
            problems.push(`${signaturesPath} records ${list.commit} but its lines are not that commit's ${SCRIPT_FILE} export signatures. ${fix}`);
        }
    }
    // With several independent bases the list holds one of them; every other one's exports must
    // stay importable too.
    for (const base of bases) {
        if (base === list.commit) continue;
        const missing = upstreamNames(ts, repo, base).filter(name => !ours.has(name));
        if (missing.length > 0) {
            problems.push(`${SCRIPT_FILE} does not export ${missing.length} name(s) that ${UPSTREAM_REF} ${base} (also contained in this commit) exports:\n`
                + missing.map(name => `  ${name}`).join('\n'));
        }
        const baseSignatures = parseSignatures(upstreamSignatures(ts, repo, base), `${base}:${SIGNATURES_FILE}`);
        problems.push(...signatureProblems(baseSignatures.entries, ours, oursSignature, `${UPSTREAM_REF} ${base}, also contained in this commit`));
    }
    return problems;
}

async function check(argv) {
    const options = parseOptions(argv, ['--root', '--repo']);
    const root = path.resolve(options['--root'] ?? '.');
    const repo = path.resolve(options['--repo'] ?? root);
    const ts = await loadTypeScript();

    const listPath = path.join(root, LIST_FILE);
    const list = readList(listPath);
    const scriptPath = path.join(root, SCRIPT_FILE);
    let source;
    try {
        source = fs.readFileSync(scriptPath, 'utf8');
    } catch (error) {
        throw new CheckError(`could not read ${scriptPath} (${error.code ?? error.message}).`);
    }
    const ours = new Set(exportNames(ts, source, SCRIPT_FILE));
    const missing = list.names.filter(name => !ours.has(name));

    const signaturesPath = path.join(root, SIGNATURES_FILE);
    const signatures = readSignatures(signaturesPath);
    if (signatures.commit !== list.commit) {
        throw new CheckError(`${signaturesPath} records ${signatures.commit} but ${listPath} records ${list.commit}; both must describe the same upstream commit. Run 'npm run script-exports:refresh' and stage ${RECORD_FILES}.`);
    }
    const recorded = signatures.entries.map(([name]) => name);
    if (recorded.length !== list.names.length || recorded.some((name, i) => name !== list.names[i])) {
        throw new CheckError(`${signaturesPath} does not list the same names as ${listPath}. Run 'npm run script-exports:refresh' and stage ${RECORD_FILES}.`);
    }
    const analyzer = createAnalyzer(ts, fsReader(root), 'ours', { ours: true });
    const oursSignature = name => analyzer.signature(name);

    const problems = [];
    if (missing.length > 0) {
        problems.push(
            `${SCRIPT_FILE} no longer exports ${missing.length} name(s) that upstream/staging's ${SCRIPT_FILE} exports (${LIST_FILE}, upstream ${list.commit.slice(0, 12)}). Extensions import these, so removing them breaks them:\n`
            + missing.map(name => `  ${name}`).join('\n'),
        );
    }
    problems.push(...signatureProblems(signatures.entries, ours, oursSignature, `${SIGNATURES_FILE}, upstream ${list.commit.slice(0, 12)}`));
    problems.push(...checkFreshness(ts, repo, list, listPath, signatures, signaturesPath, ours, oursSignature));

    if (problems.length > 0) {
        throw new CheckError(problems.join('\n\n'));
    }
    console.log(`script-exports: ok - all ${list.names.length} upstream/staging exports (${list.commit.slice(0, 12)}) are exported by ${SCRIPT_FILE} with compatible signatures.`);
}

function toplevel() {
    return git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
}

async function refresh(argv) {
    if (argv.length > 1) throw new CheckError('usage: script-exports.mjs refresh [REF]');
    const ts = await loadTypeScript();
    const repo = toplevel();
    let commit;
    if (argv.length === 1) {
        commit = resolveCommit(repo, argv[0]);
    } else {
        const result = upstreamBasesOfCommit(repo);
        if (result.skipped) throw new CheckError(`${result.skipped}; pass the ref to take the list from.`);
        if (result.bases.length > 1) {
            throw new CheckError(`${describeBases(result.bases)}; pass the one to take the list from.`);
        }
        commit = result.bases[0];
    }
    const text = upstreamList(ts, repo, commit);
    const signatures = upstreamSignatures(ts, repo, commit);
    fs.writeFileSync(path.join(repo, LIST_FILE), text);
    fs.writeFileSync(path.join(repo, SIGNATURES_FILE), signatures);
    console.log(`script-exports: wrote ${RECORD_FILES} from ${argv[0] ?? 'the expected commit'} (${commit}), ${text.split('\n').length - 2} names.`);
}

async function mergeUpstream(argv) {
    if (argv.length > 0) throw new CheckError('usage: script-exports.mjs merge-upstream');
    const repo = toplevel();
    let status = 0;
    try {
        execFileSync('git', ['-C', repo, 'merge', '--no-commit', '--no-ff', UPSTREAM_REF], { stdio: 'inherit' });
    } catch (error) {
        status = error.status ?? 1;
    }
    if (mergeHeads(repo).length > 0) {
        await refresh([]);
        git(repo, ['add', '--', LIST_FILE, SIGNATURES_FILE]);
        console.log(`script-exports: staged ${RECORD_FILES}. Resolve any conflicts, then commit.`);
    }
    process.exitCode = status;
}

async function postMerge(argv) {
    if (argv.length > 1) throw new CheckError('usage: script-exports.mjs post-merge [SQUASH_FLAG]');
    const repo = toplevel();
    const ts = await loadTypeScript();
    const now = upstreamBasesIn(repo, ['HEAD']);
    if (now.skipped) {
        notice(`${now.skipped}, so whether this merge left ${LIST_FILE} behind was not checked.`);
        return;
    }
    const before = gitSucceeds(repo, ['rev-parse', '--verify', '--quiet', 'ORIG_HEAD^{commit}'])
        ? upstreamBasesIn(repo, ['ORIG_HEAD'])
        : { skipped: 'no ORIG_HEAD' };
    if (before.bases && before.bases.length === now.bases.length && before.bases.every(base => now.bases.includes(base))) return;
    let committed;
    let committedSignatures;
    try {
        committed = parseList(git(repo, ['show', `HEAD:${LIST_FILE}`]), `HEAD:${LIST_FILE}`);
        committedSignatures = git(repo, ['show', `HEAD:${SIGNATURES_FILE}`]);
    } catch {
        committed = null;
    }
    if (committed && now.bases.includes(committed.commit) && committed.text === upstreamList(ts, repo, committed.commit)
        && committedSignatures === upstreamSignatures(ts, repo, committed.commit)) return;
    const bar = '!'.repeat(100);
    console.warn([
        bar,
        `script-exports: WARNING - this merge moved the newest ${UPSTREAM_REF} commits this branch contains`,
        `(now ${now.bases.join(', ')}), but the committed ${RECORD_FILES} were not refreshed to it.`,
        'The next commit will be blocked until they are:',
        `    npm run script-exports:refresh && git add ${LIST_FILE} ${SIGNATURES_FILE}`,
        `Use 'npm run merge:upstream' to merge ${UPSTREAM_REF} with the list refreshed in the same commit.`,
        bar,
    ].join('\n'));
}

function parseOptions(argv, known) {
    const options = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!known.includes(argv[i]) || argv[i + 1] === undefined) {
            throw new CheckError(`unexpected argument ${JSON.stringify(argv[i])}; expected ${known.map(k => `${k} DIR`).join(', ')}.`);
        }
        options[argv[i]] = argv[i + 1];
    }
    return options;
}

const commands = { check, refresh, 'merge-upstream': mergeUpstream, 'post-merge': postMerge };
const [command, ...rest] = process.argv.slice(2);
try {
    if (!Object.hasOwn(commands, command)) {
        throw new CheckError(`usage: script-exports.mjs ${Object.keys(commands).join(' | ')}`);
    }
    await commands[command](rest);
} catch (error) {
    if (!(error instanceof CheckError || error instanceof SignatureError)) throw error;
    console.error(`script-exports: ${command === 'post-merge' ? 'WARNING - could not check the merge' : 'failed'} - ${error.message}`);
    if (command !== 'post-merge') process.exit(1);
}
