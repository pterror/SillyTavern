const REVERSE_MIGRATED_MARKER = '__reverseMigrated';

// Purely local UI state; stored in localStorage instead of synced to the server.
class AccountStorage {
    #ready = false;

    /**
     * One-time copy of values previously persisted server-side, so upgrading users don't lose them.
     * @param {Object} serverState State from the server's settings.json accountStorage key (may be undefined)
     */
    init(serverState) {
        if (serverState && typeof serverState === 'object'
            && globalThis.localStorage.getItem(REVERSE_MIGRATED_MARKER) !== '1') {
            for (const [key, value] of Object.entries(serverState)) {
                if (key.startsWith('__')) continue;
                // Local values are more recent than the old server-side ones; don't clobber them
                if (globalThis.localStorage.getItem(key) === null) {
                    globalThis.localStorage.setItem(key, String(value));
                }
            }
            globalThis.localStorage.setItem(REVERSE_MIGRATED_MARKER, '1');
        }

        this.#ready = true;
    }

    getItem(key) {
        if (!this.#ready) {
            console.warn(`AccountStorage not ready (trying to read from ${key})`);
        }

        return globalThis.localStorage.getItem(key);
    }

    setItem(key, value) {
        if (!this.#ready) {
            console.warn(`AccountStorage not ready (trying to write to ${key})`);
        }

        const current = globalThis.localStorage.getItem(key);
        if (current === String(value)) {
            return;
        }

        globalThis.localStorage.setItem(key, String(value));
    }

    removeItem(key) {
        if (!this.#ready) {
            console.warn(`AccountStorage not ready (trying to remove ${key})`);
        }

        globalThis.localStorage.removeItem(key);
    }

    // Kept for callers that still read a server-side snapshot; state now lives only in localStorage.
    getState() {
        return {};
    }
}

export const accountStorage = new AccountStorage();
