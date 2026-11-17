/**
 * Apply one greeting edit to the cached opening layout. Stored messages keep their text and continuation;
 * only virtual greeting slots and the explicitly moved roots change.
 * @param {any[]} layout
 * @param {Record<string, any>} first
 * @param {any} edit
 * @param {{ name: string, nodeId: (alternative: any) => string|null }} options
 */
export function openingGreetingEdit(layout, first, edit, { name, nodeId }) {
    let offset = 0;
    const segments = layout.map(segment => {
        const virtual = segment.greeting && !segment.held ? 1 : 0;
        const read = index => ({ text: first.swipes?.[index] ?? null, info: first.swipe_info?.[index] ?? null });
        const row = { ...segment, greeting: segment.greeting && { ...segment.greeting }, virtual: virtual ? read(offset) : null,
            stored: Array.from({ length: segment.count }, (_, k) => read(offset + virtual + k)) };
        offset += virtual + segment.count;
        return row;
    });
    const target = segments.find(segment => segment.greeting?.id === edit.id && segment.greeting?.avatar === edit.avatar);
    if (!target) return null;
    const byGroup = new Map(segments.map(segment => [segment.group, segment]));
    const moves = edit.moves ?? [];
    // Places refer to the state before the edit; remove backwards, then insert in final order.
    for (const move of [...moves].sort((a, b) => b.from_place - a.from_place)) {
        byGroup.get(move.from_group)?.stored.splice(move.from_place - 1, 1);
    }
    for (const move of [...moves].sort((a, b) => a.to_place - b.to_place)) {
        const alternative = move.alternative;
        byGroup.get(move.to_group)?.stored.splice(move.to_place - 1, 0, {
            text: alternative.mes,
            info: { ...alternative, node_id: move.node, greeting: { id: edit.id, avatar: edit.avatar, hash: edit.hash } },
        });
    }
    for (const update of edit.groups ?? []) {
        const segment = byGroup.get(update.group);
        if (!segment || segment.stored.length !== update.count) return null;
        if (update.held !== undefined) segment.held = update.held;
    }
    target.greeting.hash = edit.hash;
    const template = target.virtual?.info ?? target.stored.find(row => row.info)?.info;
    const alternative = { mes: edit.text, name: edit.speaker?.name ?? template?.name ?? name, is_user: false,
        ...(edit.speaker ?? {}),
        ...(template?.original_avatar ? { original_avatar: template.original_avatar, force_avatar: template.force_avatar } : {}),
        extra: { greeting_id: edit.id }, greeting: target.greeting };
    target.virtual = target.held ? null : { text: edit.text, info: { ...alternative, node_id: nodeId(alternative) } };
    target.stored = target.stored.map((row, i) => ({ ...row, info: row.info && { ...row.info, greeting: target.held && i === 0 ? target.greeting : null } }));
    const rows = segments.flatMap(segment => [...(segment.virtual ? [segment.virtual] : []), ...segment.stored]);
    const selectedGreeting = first.swipe_info?.[first.swipe_id ?? 0]?.greeting;
    let selected = rows.findIndex(row => row.info?.node_id === first.node_id);
    if (selected < 0 && selectedGreeting) selected = rows.findIndex(row => row.info?.greeting?.id === selectedGreeting.id && row.info?.greeting?.avatar === selectedGreeting.avatar);
    if (selected < 0) selected = Math.min(first.swipe_id ?? 0, Math.max(0, rows.length - 1));
    return {
        opening_layout: segments.filter(segment => segment.greeting || segment.stored.length).map(({ virtual: _virtual, stored, ...segment }) => ({ ...segment, count: stored.length })),
        openings: { total: rows.length, stored: segments.reduce((n, segment) => n + segment.stored.length, 0), default_index: selected,
            alternatives: rows.flatMap((row, index) => row.info && typeof row.text === 'string' ? [{ ...row.info, mes: row.text, index }] : []) },
    };
}
