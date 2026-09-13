// Mirrors public/scripts/world-info.js's KNOWN_DECORATORS.
export const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'];

/**
 * Direct port of public/scripts/world-info.js's parseDecorators() - pure string parsing, no
 * external dependency. Ported verbatim rather than simplified: the `@@@`-prefix fallback handling
 * is subtle (an escape mechanism for writing a literal `@@@decorator`-looking line without
 * triggering it, tracked via the `fallbacked` flag) and not fully explained in the original source
 * either - faithfully replicating it is safer than guessing at the "cleaned up" intent.
 * @param {string} content The entry content to parse
 * @returns {[string[], string]} The decorators found, and the content with the decorator header stripped
 */
export function parseDecorators(content) {
    const isKnownDecorator = (data) => {
        if (data.startsWith('@@@')) {
            data = data.substring(1);
        }
        for (let i = 0; i < KNOWN_DECORATORS.length; i++) {
            if (data.startsWith(KNOWN_DECORATORS[i])) {
                return true;
            }
        }
        return false;
    };

    if (content.startsWith('@@')) {
        let newContent = content;
        const splited = content.split('\n');
        let decorators = [];
        let fallbacked = false;

        for (let i = 0; i < splited.length; i++) {
            if (splited[i].startsWith('@@')) {
                if (splited[i].startsWith('@@@') && !fallbacked) {
                    continue;
                }

                if (isKnownDecorator(splited[i])) {
                    decorators.push(splited[i].startsWith('@@@') ? splited[i].substring(1) : splited[i]);
                    fallbacked = false;
                } else {
                    fallbacked = true;
                }
            } else {
                newContent = splited.slice(i).join('\n');
                break;
            }
        }
        return [decorators, newContent];
    }

    return [[], content];
}

/**
 * Mirrors checkWorldInfo()'s @@activate/@@dont_activate check (public/scripts/world-info.js:4957-4966).
 * @param {string[]} decorators An entry's already-parsed decorators (see parseDecorators)
 * @returns {'activate'|'suppress'|null} 'activate' to force activation immediately (bypassing key
 * matching), 'suppress' to skip the entry outright, or null if neither decorator is present
 */
export function getDecoratorActivation(decorators) {
    if (!Array.isArray(decorators)) return null;
    if (decorators.includes('@@activate')) return 'activate';
    if (decorators.includes('@@dont_activate')) return 'suppress';
    return null;
}
