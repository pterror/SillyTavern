/**
 * @param {{ quota: number | undefined }} options
 * @returns {() => void}
 */
export function installBrowserStorage({ quota }) {
    const before = {
        storage: Object.getOwnPropertyDescriptor(navigator, 'storage'),
        locks: Object.getOwnPropertyDescriptor(navigator, 'locks'),
    };
    /** @type {Map<string, Promise<unknown>>} */
    const held = new Map();
    Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ quota, usage: 0 }) },
    });
    Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
            /**
             * @param {string} name
             * @param {() => unknown} callback
             */
            request(name, callback) {
                const run = (held.get(name) ?? Promise.resolve()).then(() => callback());
                held.set(name, run.catch(() => {}));
                return run;
            },
        },
    });
    return () => {
        for (const key of /** @type {const} */ (['storage', 'locks'])) {
            if (before[key]) Object.defineProperty(navigator, key, before[key]);
            else delete (/** @type {any} */ (navigator))[key];
        }
    };
}
