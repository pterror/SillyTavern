const REVERSE_MIGRATED_MARKER = '__reverseMigrated';

/**
 * Provides access to browser-local storage of arbitrary key-value pairs.
 *
 * Previously this class persisted its state to the server via saveSettingsDebounced('accountStorage'),
 * but all of its contents are purely local UI state (nav panel positions, "don't show again" warning
 * dismissals, pagination preferences, sort orders, etc.) that don't need server persistence or multi-
 * device sync. Writes now go directly to localStorage, avoiding a server round-trip and a settings
 * write on every UI toggle.
 *
 * On first init after the refactor, any values that were previously stored server-side are copied to
 * localStorage (reverse migration) so nothing is lost.
 */
class AccountStorage {
    /**
     * @type {boolean} If the storage was initialized
     */
    #ready = false;

    /**
     * Initialize the account storage.
     * Reverse-migrates any values previously stored server-side into localStorage.
     * @param {Object} serverState State from the server's settings.json accountStorage key (may be undefined)
     */
    init(serverState) {
        // Reverse migration: copy any server-stored values to localStorage so they aren't lost.
        // Only runs once per browser (guarded by the localStorage marker).
        if (serverState && typeof serverState === 'object'
            && globalThis.localStorage.getItem(REVERSE_MIGRATED_MARKER) !== '1') {
            for (const [key, value] of Object.entries(serverState)) {
                if (key.startsWith('__')) continue; // skip internal markers
                // Don't overwrite values that are already in localStorage (they're more recent)
                if (globalThis.localStorage.getItem(key) === null) {
                    globalThis.localStorage.setItem(key, String(value));
                }
            }
            globalThis.localStorage.setItem(REVERSE_MIGRATED_MARKER, '1');
        }

        this.#ready = true;
    }

    /**
     * Get the value of a key in account storage.
     * @param {string} key Key to get
     * @returns {string|null} Value of the key
     */
    getItem(key) {
        if (!this.#ready) {
            console.warn(`AccountStorage not ready (trying to read from ${key})`);
        }

        return globalThis.localStorage.getItem(key);
    }

    /**
     * Set a key in account storage.
     * @param {string} key Key to set
     * @param {string} value Value to set
     */
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

    /**
     * Remove a key from account storage.
     * @param {string} key Key to remove
     */
    removeItem(key) {
        if (!this.#ready) {
            console.warn(`AccountStorage not ready (trying to remove ${key})`);
        }

        globalThis.localStorage.removeItem(key);
    }

    /**
     * Gets a snapshot of the storage state.
     * Returns an empty object since values are now stored in localStorage, not server-side.
     * @returns {Record<string, string>} Empty object (server-side state is no longer maintained)
     */
    getState() {
        return {};
    }
}

/**
 * Account storage instance.
 */
export const accountStorage = new AccountStorage();
