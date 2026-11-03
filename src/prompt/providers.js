import { registerProvider } from './model.js';

/**
 * @typedef {import('./model.js').Section} Section
 */

/**
 * @typedef {object} TextHistoryItem
 * @property {string} [name]
 * @property {string} [mes]
 * @property {boolean} [is_user]
 * @property {string} [force_avatar]
 * @property {{ type?: string|null, ignore?: boolean }} [extra]
 */

/**
 * @typedef {object} ChatHistoryMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 * @property {string} [name]
 * @property {Record<string, any>} [data]
 * @property {{ role: 'assistant'|'user'|'system'|'tool', data: Record<string, any> }[]} [parts]
 */

registerProvider('history', (/** @type {{ format: 'text', items: TextHistoryItem[], continued: boolean } | { format: 'chat', messages: ChatHistoryMessage[] }} */ state) => {
    /** @type {Section[]} */
    const sections = [];
    if (state.format === 'text') {
        state.items.forEach((item, index) => {
            const last = index === state.items.length - 1;
            sections.push({
                id: `message:${index}`,
                role: item.is_user ? 'user' : item.extra?.type === 'narrator' ? 'system' : 'assistant',
                name: item.name,
                text: item.mes ?? '',
                budget: state.continued && last ? 'keep' : 'drop',
                continued: state.continued && last,
                part: 'chat_history',
                data: { forceAvatar: item.force_avatar, ignore: item.extra?.ignore === true },
            });
        });
        return sections;
    }
    state.messages.forEach((message, index) => {
        const id = `message:${index}`;
        if (message.parts) {
            sections.push({ id, budget: 'drop', part: 'chat_history', data: { toolCalls: true } });
            message.parts.forEach((part, partIndex) => {
                sections.push({ id: `${id}:${partIndex}`, parent: id, order: partIndex, role: (part.role), text: '', part: 'chat_history', data: part.data });
            });
            return;
        }
        sections.push({ id, role: message.role, name: message.name, text: message.content, budget: 'drop', part: 'chat_history', data: message.data });
    });
    return sections;
});

registerProvider('examples', (/** @type {{ format: 'text', blocks: string[] } | { format: 'chat', blocks: { role: 'system', content: string, name?: string }[][], separator: string }} */ state) => {
    const sections = [];
    if (state.format === 'text') {
        state.blocks.forEach((block, index) => sections.push({ id: `example:${index}`, text: block, budget: 'drop', part: 'examples' }));
        return sections;
    }
    state.blocks.forEach((block, index) => {
        const id = `example:${index}`;
        sections.push({ id, budget: 'drop', part: 'examples' });
        sections.push({ id: `${id}:start`, parent: id, at: { first: true }, role: 'system', text: state.separator, squash: false, part: 'chat_start' });
        block.forEach((message, messageIndex) => {
            sections.push({
                id: `${id}:${messageIndex}`, parent: id, order: messageIndex, role: message.role, name: message.name,
                text: message.content, part: 'examples', data: { alwaysName: true },
            });
        });
    });
    return sections;
});

registerProvider('card', (/** @type {{ description?: string, personality?: string, scenario?: string }} */ card) => [
    { id: 'card:description', text: card.description ?? '', part: 'description' },
    { id: 'card:personality', text: card.personality ?? '', part: 'personality' },
    { id: 'card:scenario', text: card.scenario ?? '', part: 'scenario' },
]);

registerProvider('persona', (/** @type {{ description?: string }} */ persona) => [
    { id: 'persona', text: persona.description ?? '', part: 'persona' },
]);
