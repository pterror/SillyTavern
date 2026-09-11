import yaml from 'yaml';

import { read as readCharacterCard } from './character-card-parser.js';
import { getCharaCardV2, convertToV2, computeContentIdentityHash } from './character-card-normalize.js';

/**
 * Must stay importable from a worker_threads worker: do not import character-metadata-db.js here (its
 * module-top-level getConfigValue() calls process.exit(1) on a thread without CONFIG_PATH set) or
 * endpoints/characters.js.
 */

/** Extension (lowercase, no dot) -> format key accepted by characters.js's formatImportFunctions dispatch table. */
export const EXTENSION_TO_FORMAT = {
    png: 'png',
    json: 'json',
    charx: 'charx',
    byaf: 'byaf',
    yaml: 'yaml',
    yml: 'yml',
};

/** @returns {string | null} null for an unrecognized extension (not an error - the directory isn't guaranteed to hold only character files) */
export function detectFormat(filename) {
    const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    return EXTENSION_TO_FORMAT[ext] ?? null;
}

/** @returns {'not-json' | 'unrecognized-shape' | null} null means don't pre-emptively skip */
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

    // Mirrors importFromJson()'s (characters.js) dispatch conditions.
    if (parsed.spec !== undefined || parsed.name !== undefined || parsed.char_name !== undefined) {
        return null;
    }

    return 'unrecognized-shape';
}

/**
 * Split out so a caller that already decoded a png's card text (avoiding a second, costly extractChunks()/CRC-32
 * pass over the image bytes) can hash it directly instead of going through computeCandidateContentIdentityHash().
 * @returns {string} sha256 hex digest
 */
export function computeContentIdentityHashFromRawText(rawText, directories) {
    const character = getCharaCardV2(JSON.parse(rawText), directories, false);
    return computeContentIdentityHash(character);
}

/**
 * Prefer computeContentIdentityHashFromRawText() when the caller already has the card's raw text.
 * @returns {Promise<string | null>} null for a format this can't parse without fully importing it (charx/byaf)
 */
export async function computeCandidateContentIdentityHash(sourceBuffer, format, directories) {
    switch (format) {
        case 'png': {
            const imgData = readCharacterCard(sourceBuffer);
            if (imgData === undefined) return null;
            return computeContentIdentityHashFromRawText(imgData, directories);
        }
        case 'json': {
            const raw = sourceBuffer.toString('utf8');
            return computeContentIdentityHashFromRawText(raw, directories);
        }
        case 'yaml':
        case 'yml': {
            const raw = sourceBuffer.toString('utf8');
            const yamlData = yaml.parse(raw);
            // Mirrors importFromYaml()'s (characters.js) field-shaping; nothing here is persisted.
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
            return null;
    }
}
