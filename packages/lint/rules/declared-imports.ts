import fs from 'node:fs';
import path from 'node:path';
import type { CreateRule, ESTree } from 'vite-plus/lint/plugins';

// A package imports only itself and the packages its package.json names. Its folder is its boundary: a relative
// import that leaves it, or an absolute path (the old page's `/scripts/...`), would reach code the package doesn't
// declare, so the dependency graph would stop being the whole truth.

type Package = { dir: string; dependencies: Set<string> };

const packages = new Map<string, Package | null>();

function packageOf(dir: string): Package | null {
    const known = packages.get(dir);
    if (known !== undefined) return known;
    const manifest = path.join(dir, 'package.json');
    let found: Package | null;
    if (fs.existsSync(manifest)) {
        const json = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<
            string,
            Record<string, string> | undefined
        >;
        const names = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((key) =>
            Object.keys(json[key] ?? {}),
        );
        found = { dir, dependencies: new Set(names) };
    } else {
        const parent = path.dirname(dir);
        found = parent === dir ? null : packageOf(parent);
    }
    packages.set(dir, found);
    return found;
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageName(specifier: string): string {
    const parts = specifier.split('/');
    return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

const rule: CreateRule = {
    meta: {
        type: 'problem',
        messages: {
            outside: 'This leaves the package. Import another package by its name, and declare it in package.json.',
            undeclared: "`{{name}}` is not in this package's package.json.",
            noPackage: 'This file is in no package.',
        },
    },
    create(context) {
        const file = context.filename;
        const owner = packageOf(path.dirname(file));

        function check(source: ESTree.Expression | null) {
            if (source?.type !== 'Literal' || typeof source.value !== 'string') return;
            const specifier = source.value;
            if (!owner) {
                context.report({ node: source, messageId: 'noPackage' });
                return;
            }
            if (specifier.startsWith('node:')) return;
            if (specifier.startsWith('.') || specifier.startsWith('/')) {
                const target = specifier.startsWith('/') ? specifier : path.resolve(path.dirname(file), specifier);
                const relative = path.relative(owner.dir, target);
                if (relative.startsWith('..') || path.isAbsolute(relative)) {
                    context.report({ node: source, messageId: 'outside' });
                }
                return;
            }
            const name = packageName(specifier);
            if (!owner.dependencies.has(name))
                context.report({ node: source, messageId: 'undeclared', data: { name } });
        }

        return {
            ImportDeclaration: (node) => check(node.source),
            ExportNamedDeclaration: (node) => check(node.source),
            ExportAllDeclaration: (node) => check(node.source),
            ImportExpression: (node) => check(node.source),
        };
    },
};

export default rule;
