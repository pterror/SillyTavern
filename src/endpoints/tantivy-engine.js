import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { color } from '../util.js';

/** A sibling of `<parentDir>/<name>` on the same filesystem, so swapIndexIntoPlace() can rename atomically. */
export function rebuildTempDir(parentDir, name) {
    return path.join(parentDir, `${name}.rebuild-${crypto.randomUUID()}`);
}

/** Removes the rebuild-/old- dirs of `name` left behind by a build that crashed before its swap ran. */
export function cleanupStaleRebuildDirs(parentDir, name) {
    if (!fs.existsSync(parentDir)) {
        return;
    }
    for (const entry of fs.readdirSync(parentDir)) {
        if (entry.startsWith(`${name}.rebuild-`) || entry.startsWith(`${name}.old-`)) {
            fs.rmSync(path.join(parentDir, entry), { recursive: true, force: true });
        }
    }
}

/** Swaps a fully built tempDir index into place at indexDir (old aside, new in, old removed), so a build that
 * crashes partway never leaves indexDir missing or half-written. An Index still open on tempDir must not be
 * written to afterwards: it silently no-ops instead of erroring. */
export function swapIndexIntoPlace(indexDir, tempDir) {
    if (fs.existsSync(indexDir)) {
        const oldDir = `${indexDir}.old-${crypto.randomUUID()}`;
        fs.renameSync(indexDir, oldDir);
        fs.renameSync(tempDir, indexDir);
        fs.rmSync(oldDir, { recursive: true, force: true });
    } else {
        fs.renameSync(tempDir, indexDir);
    }
}

/**
 * Resolves whether the tantivy search backend (@oxdev03/node-tantivy-binding) is usable on this install.
 * There is no fallback tier if it isn't - search is simply unavailable.
 * @type {typeof import('@oxdev03/node-tantivy-binding') | null | undefined}
 * undefined = not yet resolved, null = not usable on this install
 */
let tantivyModule = undefined;

/** Memoized process-wide; the import + smoke-test below only needs to run once per process. */
export async function getTantivyModule() {
    if (tantivyModule !== undefined) {
        return tantivyModule;
    }

    try {
        const imported = await import('@oxdev03/node-tantivy-binding');
        const candidate = imported.default ?? imported;

        // A native addon can import without error yet fail on first real use, so actually exercise it.
        const schema = new candidate.SchemaBuilder().addTextField('probe', { stored: true }).build();
        const index = new candidate.Index(schema);
        const writer = index.writer();
        writer.addDocument(candidate.Document.fromDict({ probe: 'ok' }, schema));
        writer.commit();
        index.reload();

        tantivyModule = candidate;
        return tantivyModule;
    } catch (err) {
        console.error(color.yellow('[search] The tantivy search backend (@oxdev03/node-tantivy-binding) is not usable on this install:'));
        console.error(color.yellow(`[search]   ${err.message}`));
        console.error(color.yellow('[search] There is no fallback search engine - character/group search will not be available.'));
        tantivyModule = null;
        return null;
    }
}
