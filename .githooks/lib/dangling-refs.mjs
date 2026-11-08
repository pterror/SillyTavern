// usage: dangling-refs.mjs <tsbuildinfo> <tree> <code>...   (at the top of the work tree)
// Prints the errors of tsconfig.precommit.json's program over <tree> with those codes and exits 3 if there are any, 2
// if the program couldn't be checked. Semantic errors are taken even when a file has a syntax error, which `tsc` skips
// them for. Declarations are emitted (and dropped) because that is what stores each file's signature in the build
// info: without one, a file's first change rechecks everything that imports it.

import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

import { stagedFiles, stagedSystem } from './staged-files.mjs';

const [buildInfoFile, tree, ...codes] = process.argv.slice(2);
const wanted = new Set(codes.map(Number));
const toplevel = process.cwd();
const ts = createRequire(path.join(toplevel, 'package.json'))('typescript');
const system = stagedSystem(ts, stagedFiles(toplevel, tree));
const formatHost = { getCanonicalFileName: (/** @type {string} */ name) => name, getCurrentDirectory: () => toplevel, getNewLine: () => '\n' };

/** @returns {number} */
function check() {
    /** @type {any[]} */
    const unrecoverable = [];
    const config = ts.getParsedCommandLineOfConfigFile(path.join(toplevel, 'tsconfig.precommit.json'), { incremental: true, tsBuildInfoFile: buildInfoFile, noEmit: false, declaration: true, emitDeclarationOnly: true }, {
        ...system,
        onUnRecoverableConfigFileDiagnostic: (/** @type {any} */ diagnostic) => unrecoverable.push(diagnostic),
    });
    if (!config || unrecoverable.length || config.errors.length) {
        process.stdout.write(ts.formatDiagnostics([...unrecoverable, ...(config?.errors ?? [])], formatHost));
        return 2;
    }
    const builder = ts.createIncrementalProgram({
        rootNames: config.fileNames,
        options: config.options,
        configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(config),
        projectReferences: config.projectReferences,
        host: ts.createIncrementalCompilerHost(config.options, system),
    });
    while (builder.getSemanticDiagnosticsOfNextAffectedFile());
    const options = builder.getOptionsDiagnostics();
    if (options.some((/** @type {any} */ diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
        process.stdout.write(ts.formatDiagnostics(options, formatHost));
        return 2;
    }
    const found = [...builder.getGlobalDiagnostics(), ...builder.getSemanticDiagnostics()].filter(diagnostic => wanted.has(diagnostic.code));
    const buildInfo = path.resolve(buildInfoFile);
    builder.emit(undefined, (/** @type {string} */ file, /** @type {string} */ text) => {
        if (path.resolve(file) === buildInfo) ts.sys.writeFile(file, text);
    });
    process.stdout.write(ts.formatDiagnostics(found, formatHost));
    return found.length ? 3 : 0;
}

process.exitCode = check();
