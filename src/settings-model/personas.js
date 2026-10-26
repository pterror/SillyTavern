import { TYPE } from '../library-codes.js';
import { draft, without } from './entity-draft.js';

/**
 * Personas (§1.5, step 3d): a catalog entity each (`TYPE.persona`, key its avatar file name) with its `name`,
 * `description`, `title`, `position`, `depth`, `role` and `lorebook` (a book, by name), made from upstream's
 * settings and given back as them.
 *
 * The persona is a slot of the cascade:
 * - the user-level statement is upstream's `default_persona ?? user_avatar` (§2.4.12);
 * - a character's or group's connected personas are a character-level statement each, a list of persona keys, so a
 *   persona's `connections` is derived from them (an index, persona → characters), stored once;
 * - the chat lock (`chat_metadata.persona`) is the chat's, not here.
 * `username` is derived from the resolved persona; it's kept as an override only when no persona has the avatar (Q6).
 */

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 * @typedef {{ type: 'character' | 'group', id: string }} PersonaConnection
 * @typedef {object} UpstreamPersonaSettings
 * @property {Record<string, string>} [personas] Avatar → name.
 * @property {Record<string, Record<string, any>>} [persona_descriptions] Avatar → record.
 * @property {Record<string, Record<string, any>>} [persona_data] This fork's avatar → merged record.
 * @property {string | null} [default_persona]
 * @property {string} [user_avatar]
 * @property {string} [username]
 * @typedef {object} PersonasFromUpstream
 * @property {EntityDraft[]} personas
 * @property {string | undefined} userPersona The user-level statement.
 * @property {{ holder: PersonaConnection, personas: string[] }[]} connected Character-level statements, in the order
 *   upstream's lists first name each holder.
 * @property {string | undefined} username An override, kept only when no persona has the user's avatar.
 * @property {string[]} warnings
 */

/**
 * @param {UpstreamPersonaSettings} settings
 * @returns {PersonasFromUpstream}
 */
export function personasFromUpstream(settings) {
    /** @type {string[]} */
    const warnings = [];
    const data = settings.persona_data ?? {};
    const names = settings.personas ?? {};
    const descriptions = settings.persona_descriptions ?? {};
    const avatars = [...new Set([...Object.keys(data), ...Object.keys(names), ...Object.keys(descriptions)])];
    /** @type {Map<string, { holder: PersonaConnection, personas: string[] }>} */
    const connected = new Map();
    const personas = avatars.map((avatar) => {
        // This fork's merged record wins; else upstream's two dictionaries, as the page merges them.
        const record = data[avatar] ?? { ...descriptions[avatar], name: names[avatar] ?? descriptions[avatar]?.name ?? '' };
        for (const connection of Array.isArray(record.connections) ? record.connections : []) {
            if (!connection || (connection.type !== 'character' && connection.type !== 'group') || typeof connection.id !== 'string') {
                warnings.push(`persona ${JSON.stringify(avatar)}: a connection that names no character or group is dropped: ${JSON.stringify(connection)}`);
                continue;
            }
            const holder = `${connection.type}:${connection.id}`;
            if (!connected.has(holder)) connected.set(holder, { holder: { type: connection.type, id: connection.id }, personas: [] });
            const list = connected.get(holder).personas;
            if (!list.includes(avatar)) list.push(avatar);
        }
        return draft(TYPE.persona, avatar, without(record, ['connections']));
    });
    const userPersona = settings.default_persona || settings.user_avatar || undefined;
    if (settings.default_persona && settings.user_avatar && settings.default_persona !== settings.user_avatar) {
        warnings.push(`the current persona ${JSON.stringify(settings.user_avatar)} and the default ${JSON.stringify(settings.default_persona)} become one user-level persona, the default`);
    }
    const hasEntry = settings.user_avatar !== undefined && avatars.includes(settings.user_avatar);
    return {
        personas,
        userPersona,
        connected: [...connected.values()],
        username: hasEntry ? undefined : settings.username,
        warnings,
    };
}

/**
 * Upstream's persona settings from the personas and the statements.
 * @param {EntityDraft[]} personas
 * @param {{ userPersona?: string, connected?: { holder: PersonaConnection, personas: string[] }[], username?: string }} statements
 * @returns {{ persona_data: Record<string, Record<string, unknown>>, personas: Record<string, unknown>, persona_descriptions: Record<string, Record<string, unknown>>, default_persona: string | null, user_avatar: string | undefined, username: string | undefined }}
 */
export function personasToUpstream(personas, statements) {
    /** @type {Map<string, PersonaConnection[]>} */
    const connectionsOf = new Map();
    for (const { holder, personas: list } of statements.connected ?? []) {
        for (const avatar of list) {
            if (!connectionsOf.has(avatar)) connectionsOf.set(avatar, []);
            connectionsOf.get(avatar).push({ ...holder });
        }
    }
    /** @type {Record<string, Record<string, unknown>>} */
    const persona_data = {};
    for (const persona of personas) {
        persona_data[persona.key] = { ...persona.values, connections: connectionsOf.get(persona.key) ?? [] };
    }
    const user = statements.userPersona;
    const userEntry = user !== undefined ? persona_data[user] : undefined;
    return {
        persona_data,
        personas: Object.fromEntries(Object.entries(persona_data).map(([avatar, record]) => [avatar, record.name])),
        persona_descriptions: Object.fromEntries(Object.entries(persona_data).map(([avatar, record]) => [avatar, without(record, ['name'])])),
        default_persona: user ?? null,
        user_avatar: user,
        username: userEntry ? /** @type {string} */ (userEntry.name) : statements.username,
    };
}
