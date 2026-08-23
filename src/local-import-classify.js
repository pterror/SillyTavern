import yaml from 'yaml';

import { read as readCharacterCard } from './character-card-parser.js';
import { getCharaCardV2, convertToV2, computeContentIdentityHash } from './character-card-normalize.js';

/**
 * Pure, DB-free, config-load-free, no-filesystem-write classification/hashing helpers shared between
 * local-import-scan.js's main-thread code and local-import-worker.js's worker-thread pipeline (2026-08
 * local-import worker-pool work). Split out of local-import-scan.js specifically so importing this module -
 * from inside a worker_threads worker - never drags in character-metadata-db.js's DB-writing exports,
 * endpoints/characters.js's much heavier import machinery (multer, express route registration, etc.), OR
 * (found the hard way, via every worker in the pool silently dying at import time and every dispatched task
 * hanging until its 5s test timeout) character-metadata-db.js's own module-TOP-LEVEL getConfigValue() calls,
 * which call process.exit(1) if CONFIG_PATH hasn't been set on THIS thread via util.js's
 * setConfigFilePath() - main-thread-only module state a worker_threads worker never inherits (workers get
 * their own fresh module registry, not a shared one). computeContentIdentityHash() therefore now lives in
 * character-card-normalize.js instead (see that module's own doc comment on it), which has no such
 * top-level config dependency - imported from there, not from character-metadata-db.js.
 *
 * Every export below operates only on bytes already in memory (a Buffer the caller already read) and
 * config/path values - never touches sqlite, and never calls getConfigValue()/reads config.yaml (see
 * local-import-worker.js's own header on why DB and config access must stay off worker threads entirely for
 * this feature).
 */

/** Extension (lowercase, no dot) -> format key accepted by characters.js's formatImportFunctions dispatch table.
 * Deliberately the full set `/import` recognizes (see that route), not a subset - a locally-dropped file is no
 * less legitimate a source than a browser upload of the same format. */
export const EXTENSION_TO_FORMAT = {
    png: 'png',
    json: 'json',
    charx: 'charx',
    byaf: 'byaf',
    yaml: 'yaml',
    yml: 'yml',
};

/**
 * @param {string} filename
 * @returns {string | null} A formatImportFunctions key, or null if this filename isn't a recognized character
 * file format at all (e.g. a stray .txt or .DS_Store dropped into a watched directory) - such files are silently
 * ignored, not an error, since a watched directory isn't guaranteed to contain only character files.
 */
export function detectFormat(filename) {
    const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    return EXTENSION_TO_FORMAT[ext] ?? null;
}

/**
 * Cheap, non-destructive pre-check for a `.json`-extension candidate - see local-import-scan.js's original
 * doc comment on this function (unchanged behavior, only relocated). Two real corpus-hygiene shapes get
 * recognized: 'not-json' (bytes aren't valid JSON at all) and 'unrecognized-shape' (valid JSON, but not any
 * shape importFromJson() actually dispatches on). Returns `null` for anything else, meaning "don't
 * pre-emptively skip".
 * @param {Buffer} sourceBuffer The source file's raw bytes, already read by the caller.
 * @returns {'not-json' | 'unrecognized-shape' | null}
 */
export function classifyJsonCandidate(sourceBuffer) {
    let parsed;
    try {
        parsed = JSON.parse(sourceBuffer.toString('utf8'));
    } catch {
        return 'not-json';
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'unrecognized-shape';
    }

    // Mirrors importFromJson()'s (characters.js) own dispatch conditions exactly - see that function.
    if (parsed.spec !== undefined || parsed.name !== undefined || parsed.char_name !== undefined) {
        return null;
    }

    return 'unrecognized-shape';
}

/**
 * Non-destructively parses `sourceBuffer` into the same normalized shape computeContentIdentityHash() always
 * hashes from, and returns that hash - or `null` for a format this doesn't (yet) know how to parse without
 * importing it (charx/byaf - see local-import-scan.js's original doc comment for the full rationale, unchanged
 * by this relocation).
 * @param {Buffer} sourceBuffer
 * @param {string} format A formatImportFunctions key (see EXTENSION_TO_FORMAT)
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<string | null>}
 */
export async function computeCandidateContentIdentityHash(sourceBuffer, format, directories) {
    switch (format) {
        case 'png': {
            const imgData = readCharacterCard(sourceBuffer);
            if (imgData === undefined) return null;
            const character = getCharaCardV2(JSON.parse(imgData), directories, false);
            return computeContentIdentityHash(character);
        }
        case 'json': {
            const raw = sourceBuffer.toString('utf8');
            const character = getCharaCardV2(JSON.parse(raw), directories, false);
            return computeContentIdentityHash(character);
        }
        case 'yaml':
        case 'yml': {
            const raw = sourceBuffer.toString('utf8');
            const yamlData = yaml.parse(raw);
            // Mirrors importFromYaml()'s (characters.js) own field-shaping object, minus everything that
            // function does AFTER building it - this is only ever used to compute a hash, nothing here is
            // persisted.
            const shaped = convertToV2({
                name: yamlData.name,
                description: yamlData.context ?? '',
                first_mes: yamlData.greeting ?? '',
                create_date: new Date().toISOString(),
                chat: '',
                personality: '',
                creatorcomment: '',
                avatar: 'none',
                mes_example: '',
                scenario: '',
                talkativeness: 0.5,
                creator: '',
                tags: '',
            }, directories);
            return computeContentIdentityHash(shaped);
        }
        default:
            // charx/byaf (or anything else EXTENSION_TO_FORMAT maps to that isn't handled above) - see this
            // function's own doc comment.
            return null;
    }
}
