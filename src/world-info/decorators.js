export const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'];

/**
 * @param {string} content
 * @returns {[string[], string]}
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
 * @param {string[]} decorators
 * @returns {'activate'|'suppress'|null}
 */
export function getDecoratorActivation(decorators) {
    if (!Array.isArray(decorators)) return null;
    if (decorators.includes('@@activate')) return 'activate';
    if (decorators.includes('@@dont_activate')) return 'suppress';
    return null;
}
