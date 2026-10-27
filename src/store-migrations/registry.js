import { CHAT_NAMES_META } from '../chat-engine.js';

/**
 * The data migrations a user's store goes through, in order (docs/design/install-and-update.md, "Data migrations,
 * run by the server"). The server runs the ones a store hasn't recorded before serving it (`run.js`); a store made by
 * this version is made with all of them recorded.
 *
 * @typedef {object} MigrationContext
 * @property {import('../user-stores.js').UserStore} store The user's store, open.
 * @property {import('../users.js').UserDirectoryList} directories
 * @property {string} handle
 * @property {unknown} saved What the migration saved last (`save()`) on a run a stop cut short; null on a first run.
 * @property {(state: unknown) => Promise<void>} save Keeps how far it got, so a run cut short goes on from there.
 * @property {(done: number, total: number) => void} progress For the progress page.
 * @property {(line: string) => void} log
 *
 * @typedef {object} Migration
 * @property {string} id
 * @property {string} description
 * @property {string} [doneBefore] A store meta key a hand-run one-off left, meaning it's done already.
 * @property {() => Promise<{ run: (context: MigrationContext) => Promise<void> }>} load
 */

/** @type {readonly Migration[]} */
export const MIGRATIONS = Object.freeze([
    {
        id: 'name-every-chat',
        description: 'Every chat named, its name its id',
        doneBefore: CHAT_NAMES_META,
        load: () => import('./name-every-chat.js'),
    },
]);

/** @param {string} id The store meta key recording a migration done. */
export function doneKey(id) {
    return `migration.${id}`;
}

/** @param {string} id The store meta key keeping how far a migration got. */
export function stateKey(id) {
    return `migration.${id}.state`;
}

/**
 * The records marking migrations done.
 * @param {string[]} ids
 * @param {number} [time]
 */
export function doneRecords(ids, time = Date.now()) {
    return ids.map(id => ({ kind: 'metaValue', key: doneKey(id), json: JSON.stringify({ done: time }) }));
}

/**
 * The migrations a store hasn't recorded, in order.
 * @param {any} engineStore The engine's `Store`.
 * @param {readonly Migration[]} [migrations] The registered ones; tests give their own.
 * @returns {Promise<Migration[]>}
 */
export async function pendingMigrations(engineStore, migrations = MIGRATIONS) {
    const keys = migrations.flatMap(m => [doneKey(m.id), ...(m.doneBefore ? [m.doneBefore] : [])]);
    const values = new Map((await engineStore.meta(keys)).map((/** @type {unknown} */ v, /** @type {number} */ i) => [keys[i], v]));
    return migrations.filter(m => values.get(doneKey(m.id)) == null && (!m.doneBefore || values.get(m.doneBefore) == null));
}
