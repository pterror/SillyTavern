import { TYPE } from '../library-codes.js';
import { draft, without } from './entity-draft.js';

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 * @typedef {{ type: 'character' | 'group', id: string }} PersonaConnection
 * @typedef {object} UpstreamPersonaSettings
 * @property {Record<string, string>} [personas]
 * @property {Record<string, Record<string, any>>} [persona_descriptions]
 * @property {Record<string, Record<string, any>>} [persona_data]
 * @property {string | null} [default_persona]
 * @property {string} [user_avatar]
 * @property {string} [username]
 * @typedef {object} PersonasFromUpstream
 * @property {EntityDraft[]} personas
 * @property {string | null | undefined} userPersona
 * @property {string | undefined} currentPersona
 * @property {{ holder: PersonaConnection, personas: string[] }[]} connected
 * @property {string | undefined} username
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
    const hasEntry = settings.user_avatar !== undefined && avatars.includes(settings.user_avatar);
    return {
        personas,
        userPersona: settings.default_persona,
        currentPersona: settings.user_avatar,
        connected: [...connected.values()],
        username: hasEntry ? undefined : settings.username,
        warnings,
    };
}

/**
 * @param {EntityDraft[]} personas
 * @param {{ userPersona?: string | null, currentPersona?: string, connected?: { holder: PersonaConnection, personas: string[] }[], username?: string }} statements
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
    const current = statements.currentPersona;
    const currentEntry = current !== undefined ? persona_data[current] : undefined;
    return {
        persona_data,
        personas: Object.fromEntries(Object.entries(persona_data).map(([avatar, record]) => [avatar, record.name])),
        persona_descriptions: structuredClone(persona_data),
        default_persona: statements.userPersona ?? null,
        user_avatar: current,
        username: currentEntry ? /** @type {string} */ (currentEntry.name) : statements.username,
    };
}
