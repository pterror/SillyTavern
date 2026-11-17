import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** The page's code and the server's code: neither imports the other's; code both use is in packages/shared. */
const SIDES = [
    { name: 'page', directory: 'public', skipped: new Set(['lib']) },
    { name: 'server', directory: 'src', skipped: new Set(['tokenizers']) },
];

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist']);

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

/**
 * @param {string} dir
 * @param {Set<string>} skipped
 * @param {string[]} [out]
 * @returns {string[]}
 */
function sourceFiles(dir, skipped, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name) && !skipped.has(entry.name)) sourceFiles(path.join(dir, entry.name), new Set(), out);
        } else if (/\.(m|c)?[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

/**
 * @param {string} root
 * @param {string} file
 * @param {string} specifier
 * @param {string} sideDirectory
 * @returns {string|null} The imported path, relative to `root`, when the specifier names a file in this repository.
 */
function resolved(root, file, specifier, sideDirectory) {
    if (specifier.startsWith('.')) return path.relative(root, path.resolve(path.dirname(file), specifier));
    if (specifier.startsWith('/') && sideDirectory === 'public') return path.join('public', specifier);
    return null;
}

/**
 * @param {string} root
 * @returns {string[]} Each import of the other side's code, as `file: specifier`.
 */
export function crossImports(root) {
    const found = [];
    for (const side of SIDES) {
        const others = SIDES.filter(other => other !== side).map(other => other.directory + path.sep);
        for (const file of sourceFiles(path.join(root, side.directory), side.skipped)) {
            const source = fs.readFileSync(file, 'utf8');
            for (const [, , specifier] of source.matchAll(SPECIFIER)) {
                const target = resolved(root, file, specifier, side.directory);
                if (target !== null && others.some(other => target.startsWith(other))) {
                    found.push(`${path.relative(root, file)}: ${specifier}`);
                }
            }
        }
    }
    return found.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const found = crossImports(path.resolve(process.argv[2] ?? '.'));
    if (found.length > 0) {
        console.error('Imports of the other side\'s code (code both the page and the server use belongs in packages/shared):');
        for (const line of found) console.error(`  ${line}`);
        process.exit(1);
    }
}
