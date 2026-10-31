import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vite-plus/test';
import { lintConfig } from './config.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

type Diagnostic = { code: string; filename: string; labels: { span: { line: number } }[] };

function lint(): Diagnostic[] {
    const config = path.join(ROOT, `.oxlintrc.rules-test-${process.pid}.json`);
    fs.writeFileSync(config, JSON.stringify(lintConfig));
    try {
        return JSON.parse(run(['vp', 'lint', '-c', config, '--format', 'json', path.relative(ROOT, FIXTURES)]))
            .diagnostics;
    } finally {
        fs.rmSync(config);
    }
}

function run(args: string[]): string {
    try {
        return execFileSync('npx', args, { cwd: ROOT, encoding: 'utf8' });
    } catch (error) {
        return (error as { stdout: string }).stdout;
    }
}

function expected(file: string): string[] {
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((text, index) =>
            [...text.matchAll(/expect: ([\w-]+\([\w/-]+\))/g)].map((match) => `${index + 1} ${match[1]}`),
        );
}

const diagnostics = lint();

for (const area of fs.readdirSync(FIXTURES)) {
    const dir = path.join(FIXTURES, area);
    const reported = (file: string) =>
        diagnostics.filter((d) => path.resolve(ROOT, d.filename) === path.join(dir, file));

    test(`${area}: each marked line gets exactly its diagnostics`, () => {
        const got = reported('bad.tsx')
            .filter((d) => !d.code.startsWith('typescript('))
            .map((d) => `${d.labels[0]?.span.line} ${d.code}`);
        expect(got.sort()).toEqual(expected(path.join(dir, 'bad.tsx')).sort());
    });

    test(`${area}: the good fixture gets nothing`, () => {
        expect(reported('good.tsx').map((d) => `${d.labels[0]?.span.line} ${d.code}`)).toEqual([]);
    });
}
