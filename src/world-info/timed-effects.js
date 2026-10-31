/**
 * @typedef {'sticky'|'cooldown'|'delay'} TimedEffectType
 * @typedef {{hash: number, start: number, end: number, protected: boolean}} TimedEffect
 */
export class WorldInfoTimedEffects {
    #chat;
    #entries;
    #chatMetadata;
    #isDryRun;
    #buffer = { sticky: [], cooldown: [], delay: [] };

    /**
     * @param {string[]} chat
     * @param {object[]} entries
     * @param {object} chatMetadata
     * @param {boolean} [isDryRun]
     */
    constructor(chat, entries, chatMetadata, isDryRun = false) {
        this.#chat = chat;
        this.#entries = entries;
        this.#chatMetadata = chatMetadata;
        this.#isDryRun = isDryRun;
        this.#ensureChatMetadata();
    }

    #ensureChatMetadata() {
        if (!this.#chatMetadata.timedWorldInfo) {
            this.#chatMetadata.timedWorldInfo = {};
        }
        for (const type of ['sticky', 'cooldown']) {
            if (!this.#chatMetadata.timedWorldInfo[type] || typeof this.#chatMetadata.timedWorldInfo[type] !== 'object') {
                this.#chatMetadata.timedWorldInfo[type] = {};
            }
            for (const [key, value] of Object.entries(this.#chatMetadata.timedWorldInfo[type])) {
                if (!value || typeof value !== 'object') {
                    delete this.#chatMetadata.timedWorldInfo[type][key];
                }
            }
        }
    }

    #getEntryHash(entry) {
        return entry.hash;
    }

    #getEntryKey(entry) {
        return `${entry.world}.${entry.uid}`;
    }

    /** @returns {TimedEffect} */
    #getEntryTimedEffect(type, entry, isProtected) {
        return {
            hash: this.#getEntryHash(entry),
            start: this.#chat.length,
            end: this.#chat.length + Number(entry[type]),
            protected: !!isProtected,
        };
    }

    #checkTimedEffectOfType(type, buffer, onEnded) {
        const effects = Object.entries(this.#chatMetadata.timedWorldInfo[type]);
        for (const [key, value] of effects) {
            const entry = this.#entries.find(x => String(this.#getEntryHash(x)) === String(value.hash));

            if (this.#chat.length <= Number(value.start) && !value.protected) {
                delete this.#chatMetadata.timedWorldInfo[type][key];
                continue;
            }

            if (!entry) {
                if (this.#chat.length >= Number(value.end)) {
                    delete this.#chatMetadata.timedWorldInfo[type][key];
                }
                continue;
            }

            if (!entry[type]) {
                delete this.#chatMetadata.timedWorldInfo[type][key];
                continue;
            }

            if (this.#chat.length >= Number(value.end)) {
                delete this.#chatMetadata.timedWorldInfo[type][key];
                if (typeof onEnded === 'function') onEnded(entry);
                continue;
            }

            buffer.push(entry);
        }
    }

    #checkDelayEffect(buffer) {
        for (const entry of this.#entries) {
            if (!entry.delay) continue;
            if (this.#chat.length < entry.delay) buffer.push(entry);
        }
    }

    #onStickyEnded(entry) {
        if (!entry.cooldown) return;
        const key = this.#getEntryKey(entry);
        const effect = this.#getEntryTimedEffect('cooldown', entry, true);
        this.#chatMetadata.timedWorldInfo.cooldown[key] = effect;
        this.#buffer.cooldown.push(entry);
    }

    checkTimedEffects() {
        if (!this.#isDryRun) {
            this.#checkTimedEffectOfType('sticky', this.#buffer.sticky, (entry) => this.#onStickyEnded(entry));
            this.#checkTimedEffectOfType('cooldown', this.#buffer.cooldown, null);
        }
        this.#checkDelayEffect(this.#buffer.delay);
    }

    /** @returns {TimedEffect|null} */
    getEffectMetadata(type, entry) {
        if (!this.isValidEffectType(type)) return null;
        const key = this.#getEntryKey(entry);
        return this.#chatMetadata.timedWorldInfo[type][key];
    }

    #setTimedEffectOfType(type, entry) {
        if (!entry[type]) return;
        const key = this.#getEntryKey(entry);
        if (!this.#chatMetadata.timedWorldInfo[type][key]) {
            this.#chatMetadata.timedWorldInfo[type][key] = this.#getEntryTimedEffect(type, entry, false);
        }
    }

    setTimedEffects(activatedEntries) {
        if (this.#isDryRun) return;
        for (const entry of activatedEntries) {
            this.#setTimedEffectOfType('sticky', entry);
            this.#setTimedEffectOfType('cooldown', entry);
        }
    }

    setTimedEffect(type, entry, newState) {
        if (!this.isValidEffectType(type)) return;
        if (this.#isDryRun && type !== 'delay') return;

        const key = this.#getEntryKey(entry);
        delete this.#chatMetadata.timedWorldInfo[type][key];

        if (newState) {
            this.#chatMetadata.timedWorldInfo[type][key] = this.#getEntryTimedEffect(type, entry, false);
        }
    }

    isValidEffectType(type) {
        return typeof type === 'string' && ['sticky', 'cooldown', 'delay'].includes(type.trim().toLowerCase());
    }

    isEffectActive(type, entry) {
        if (!this.isValidEffectType(type)) return false;
        return this.#buffer[type]?.some(x => this.#getEntryHash(x) === this.#getEntryHash(entry)) ?? false;
    }

    cleanUp() {
        for (const buffer of Object.values(this.#buffer)) {
            buffer.splice(0, buffer.length);
        }
    }
}
