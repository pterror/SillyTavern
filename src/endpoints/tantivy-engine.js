import { color } from '../util.js';

/**
 * Resolves whether the tantivy search backend (@oxdev03/node-tantivy-binding) is usable on this install. This is
 * the primary/fastest tier of the character/group search chain - see search-engine.js for the full tantivy-first,
 * sqlite-native-then-wasm fallback story, and sqlite-engine.js for the two tiers underneath this one.
 *
 * WHY TANTIVY OVER FTS5 (the tier this replaces as the primary engine - sqlite-engine.js's native/wasm tiers
 * still exist as fallbacks, see search-engine.js): FTS5's MATCH query cost scales with how many postings a term
 * has, not just result-set size - measured a single-word query for a common English word ("the") taking ~78ms
 * against this install's real library and getting *worse* as the library grows, since a broader prefix or a more
 * common term touches more of the index regardless of how few results actually get returned. Tantivy's
 * BM25-scored search over the same shape of query measured a flat 0-1ms regardless of term commonality - not
 * "usually faster," structurally not subject to the same broad-query blowup, because it's a proper inverted-index
 * search engine (Lucene-family design) rather than a general-purpose relational engine with a text-search virtual
 * table bolted on.
 *
 * THE BINDING'S OWN PLATFORM COVERAGE IS NARROWER THAN SQLITE'S: @oxdev03/node-tantivy-binding's
 * optionalDependencies (its own package.json) ship prebuilt natives for darwin-arm64/x64, win32-x64-msvc, and
 * linux-x64-gnu only - no linux-arm64, no musl (Alpine) - and unlike better-sqlite3 there's no WASM build of this
 * library to fall back to if the native one can't load. That's exactly why this module's failure mode is "return
 * null and let the caller fall back to the sqlite chain," not "throw" - a working-but-slower tier beats no search,
 * the same reasoning sqlite-engine.js already applies one level down for its own native-vs-wasm choice.
 * @type {typeof import('@oxdev03/node-tantivy-binding') | null | undefined}
 * undefined = not yet resolved, null = not usable on this install
 */
let tantivyModule = undefined;

/**
 * @returns {Promise<typeof import('@oxdev03/node-tantivy-binding') | null>} The tantivy module, or null if it
 * isn't usable on this install (already logged a diagnostic in that case). Memoized process-wide, same pattern as
 * sqlite-engine.js's `engine` cache - the resolution work (importing the native addon, running the smoke test
 * below) only needs to happen once per process, not once per search request.
 */
export async function getTantivyModule() {
    if (tantivyModule !== undefined) {
        return tantivyModule;
    }

    try {
        const imported = await import('@oxdev03/node-tantivy-binding');
        const candidate = imported.default ?? imported;

        // Actually build a trivial schema + in-memory index + writer, not just trust that the import alone
        // succeeding means the native addon initialized cleanly - same reasoning as sqlite-engine.js's own
        // "construct a database, don't just import" probe, and native-sqlite.js's before it. A native addon can
        // import without error yet fail on first real use (missing shared library, ABI mismatch, etc).
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
        console.error(color.yellow('[search] Falling back to the SQLite FTS5 search chain (see sqlite-engine.js) - character/group search will still work, just slower.'));
        tantivyModule = null;
        return null;
    }
}
