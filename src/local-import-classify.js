import yaml from 'yaml';

import { read as readCharacterCard } from './character-card-parser.js';
import { getCharaCardV2, convertToV2, computeContentIdentityHash } from './character-card-normalize.js';

export const EXTENSION_TO_FORMAT = {
    png: 'png',
    json: 'json',
    charx: 'charx',
    byaf: 'byaf',
    yaml: 'yaml',
    yml: 'yml',
};

/** @returns {string | null} */
export function detectFormat(filename) {
    const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    return EXTENSION_TO_FORMAT[ext] ?? null;
}

/** @returns {'not-json' | 'unrecognized-shape' | null} */
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

    if (parsed.spec !== undefined || parsed.name !== undefined || parsed.char_name !== undefined) {
        return null;
    }

    return 'unrecognized-shape';
}

/**
 * @returns {string}
 */
export function computeContentIdentityHashFromRawText(rawText, directories) {
    const character = getCharaCardV2(JSON.parse(rawText), directories, false);
    return computeContentIdentityHash(character);
}

/**
 * @returns {Promise<string | null>}
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
