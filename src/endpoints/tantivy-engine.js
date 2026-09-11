import { color } from '../util.js';

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
