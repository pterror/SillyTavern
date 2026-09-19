import { describe, test, expect, jest } from '@jest/globals';
import { EntityStore, DictEntityStore, RelationStore } from '../public/scripts/entity-store.js';

describe('EntityStore', () => {
    function makeStore(initial = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]) {
        const array = initial;
        const store = new EntityStore(array, e => e.id);
        return { array, store };
    }

    test('get/has/getAll reflect the backing array', () => {
        const { array, store } = makeStore();
        expect(store.get('a')).toBe(array[0]);
        expect(store.has('a')).toBe(true);
        expect(store.has('z')).toBe(false);
        expect(store.getAll()).toBe(array);
    });

    test('create() pushes onto the same array reference and emits created', () => {
        const { array, store } = makeStore([]);
        const listener = jest.fn();
        store.onChange(listener);
        const entity = { id: 'c', name: 'Gamma' };
        const change = store.create(entity);
        expect(array).toContain(entity);
        expect(store.get('c')).toBe(entity);
        expect(change).toEqual({ op: 'created', id: 'c', entity });
        expect(listener).toHaveBeenCalledWith(change);
    });

    test('update() patches the entity in place (same reference) and emits updated with the patch', () => {
        const { array, store } = makeStore();
        const before = array[0];
        const listener = jest.fn();
        store.onChange(listener);
        const change = store.update('a', { name: 'Updated' });
        expect(array[0]).toBe(before); // same object, mutated
        expect(array[0].name).toBe('Updated');
        expect(change).toEqual({ op: 'updated', id: 'a', entity: before, patch: { name: 'Updated' } });
        expect(listener).toHaveBeenCalledWith(change);
    });

    test('update() on a missing id returns null and does not emit', () => {
        const { store } = makeStore();
        const listener = jest.fn();
        store.onChange(listener);
        expect(store.update('missing', { name: 'x' })).toBeNull();
        expect(listener).not.toHaveBeenCalled();
    });

    test('remove() splices from the backing array and drops the id index', () => {
        const { array, store } = makeStore();
        const listener = jest.fn();
        store.onChange(listener);
        const change = store.remove('a');
        expect(array.find(e => e.id === 'a')).toBeUndefined();
        expect(store.has('a')).toBe(false);
        expect(change.op).toBe('removed');
        expect(listener).toHaveBeenCalledWith(change);
    });

    test('remove() on a missing id returns null and does not emit', () => {
        const { store } = makeStore();
        const listener = jest.fn();
        store.onChange(listener);
        expect(store.remove('missing')).toBeNull();
        expect(listener).not.toHaveBeenCalled();
    });

    test('reorder() applies the given order and keeps unmentioned ids at the end', () => {
        const { array, store } = makeStore([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        const listener = jest.fn();
        store.onChange(listener);
        const change = store.reorder(['c', 'a']);
        expect(array.map(e => e.id)).toEqual(['c', 'a', 'b']);
        expect(change).toEqual({ op: 'reordered', ids: ['c', 'a'] });
        expect(listener).toHaveBeenCalledWith(change);
    });

    test('reorder() drops ids that no longer exist in the backing array', () => {
        const { array, store } = makeStore([{ id: 'a' }, { id: 'b' }]);
        store.reorder(['b', 'ghost', 'a']);
        expect(array.map(e => e.id)).toEqual(['b', 'a']);
    });

    test('reset() re-syncs the id index from the array and emits a single reset', () => {
        const { array, store } = makeStore([{ id: 'a' }]);
        // simulate the array being rebuilt out from under the store (e.g. a full refetch)
        array.length = 0;
        array.push({ id: 'a' }, { id: 'z' });
        const listener = jest.fn();
        store.onChange(listener);
        expect(store.has('z')).toBe(false); // index is stale before reset()
        const change = store.reset();
        expect(store.has('z')).toBe(true);
        expect(change).toEqual({ op: 'reset' });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('reindex() re-syncs the index without emitting', () => {
        const { array, store } = makeStore([{ id: 'a' }]);
        array.push({ id: 'z' });
        const listener = jest.fn();
        store.onChange(listener);
        store.reindex();
        expect(store.has('z')).toBe(true);
        expect(listener).not.toHaveBeenCalled();
    });

    test('reportCreated()/reportRemoved()/reportRenamed() emit without mutating the array themselves', () => {
        const { array, store } = makeStore([{ id: 'a' }]);
        array.push({ id: 'new' });
        store.reindex();
        const listener = jest.fn();
        store.onChange(listener);

        const createdChange = store.reportCreated('new');
        expect(createdChange).toEqual({ op: 'created', id: 'new', entity: array[1] });

        const removedEntity = array.pop();
        store.reindex();
        const removedChange = store.reportRemoved('new', removedEntity);
        expect(removedChange).toEqual({ op: 'removed', id: 'new', entity: removedEntity });

        array[0].id = 'renamed';
        store.reindex();
        const renamedChange = store.reportRenamed('a', 'renamed');
        expect(renamedChange).toEqual({ op: 'renamed', oldId: 'a', newId: 'renamed', entity: array[0] });

        expect(listener).toHaveBeenCalledTimes(3);
    });

    test('reportCreated()/reportRenamed() return null when the id is not present in the index', () => {
        const { store } = makeStore([]);
        expect(store.reportCreated('ghost')).toBeNull();
        expect(store.reportRenamed('a', 'ghost')).toBeNull();
    });

    test('onChange() unsubscribe stops further notifications', () => {
        const { store } = makeStore([]);
        const listener = jest.fn();
        const unsubscribe = store.onChange(listener);
        store.create({ id: 'a' });
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        store.create({ id: 'b' });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('multiple listeners all receive every change', () => {
        const { store } = makeStore([]);
        const l1 = jest.fn();
        const l2 = jest.fn();
        store.onChange(l1);
        store.onChange(l2);
        store.create({ id: 'a' });
        expect(l1).toHaveBeenCalledTimes(1);
        expect(l2).toHaveBeenCalledTimes(1);
    });
});

describe('DictEntityStore', () => {
    function makeStore(initial = { a: { name: 'Alpha' }, b: { name: 'Beta' } }) {
        return { dict: initial, store: new DictEntityStore(initial) };
    }

    test('get/has/getAll reflect the backing dict', () => {
        const { dict, store } = makeStore();
        expect(store.get('a')).toBe(dict.a);
        expect(store.has('a')).toBe(true);
        expect(store.has('z')).toBe(false);
        expect(store.getAll()).toBe(dict);
    });

    test('create() sets the key on the same dict reference and emits created', () => {
        const { dict, store } = makeStore({});
        const listener = jest.fn();
        store.onChange(listener);
        const entity = { name: 'Gamma' };
        const change = store.create('c', entity);
        expect(dict.c).toBe(entity);
        expect(change).toEqual({ op: 'created', id: 'c', entity });
        expect(listener).toHaveBeenCalledWith(change);
    });

    test('create() on an existing id returns null without overwriting (use update() instead)', () => {
        const { dict, store } = makeStore({ a: { name: 'Alpha' } });
        const listener = jest.fn();
        store.onChange(listener);
        expect(store.create('a', { name: 'Overwritten' })).toBeNull();
        expect(dict.a.name).toBe('Alpha');
        expect(listener).not.toHaveBeenCalled();
    });

    test('update() patches the entity in place and emits updated with the patch', () => {
        const { dict, store } = makeStore();
        const before = dict.a;
        const listener = jest.fn();
        store.onChange(listener);
        const change = store.update('a', { name: 'Updated' });
        expect(dict.a).toBe(before);
        expect(dict.a.name).toBe('Updated');
        expect(change).toEqual({ op: 'updated', id: 'a', entity: before, patch: { name: 'Updated' } });
        expect(listener).toHaveBeenCalledWith(change);
    });

    test('remove() deletes the key and emits removed', () => {
        const { dict, store } = makeStore();
        const listener = jest.fn();
        store.onChange(listener);
        const change = store.remove('a');
        expect(Object.hasOwn(dict, 'a')).toBe(false);
        expect(change.op).toBe('removed');
        expect(listener).toHaveBeenCalledWith(change);
    });

    test('remove() on a missing id returns null and does not emit', () => {
        const { store } = makeStore();
        const listener = jest.fn();
        store.onChange(listener);
        expect(store.remove('missing')).toBeNull();
        expect(listener).not.toHaveBeenCalled();
    });

    test('rename() moves the entity from oldId to newId', () => {
        const { dict, store } = makeStore();
        const entity = dict.a;
        const listener = jest.fn();
        store.onChange(listener);
        const change = store.rename('a', 'renamed');
        expect(Object.hasOwn(dict, 'a')).toBe(false);
        expect(dict.renamed).toBe(entity);
        expect(change).toEqual({ op: 'renamed', oldId: 'a', newId: 'renamed', entity });
        expect(listener).toHaveBeenCalledWith(change);
    });

    test('rename() on a missing oldId returns null', () => {
        const { store } = makeStore();
        expect(store.rename('missing', 'x')).toBeNull();
    });

    test('reset() just emits (dict keys are already the index)', () => {
        const { store } = makeStore();
        const listener = jest.fn();
        store.onChange(listener);
        const change = store.reset();
        expect(change).toEqual({ op: 'reset' });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('reportCreated()/reportRemoved()/reportRenamed() emit without mutating themselves', () => {
        const { dict, store } = makeStore({});
        dict.new = { name: 'X' };
        const listener = jest.fn();
        store.onChange(listener);

        expect(store.reportCreated('new')).toEqual({ op: 'created', id: 'new', entity: dict.new });
        expect(store.reportCreated('ghost')).toBeNull();

        const removedEntity = dict.new;
        delete dict.new;
        expect(store.reportRemoved('new', removedEntity)).toEqual({ op: 'removed', id: 'new', entity: removedEntity });

        dict.renamed = removedEntity;
        expect(store.reportRenamed('new', 'renamed')).toEqual({ op: 'renamed', oldId: 'new', newId: 'renamed', entity: removedEntity });
        expect(store.reportRenamed('new', 'ghost')).toBeNull();

        expect(listener).toHaveBeenCalledTimes(3);
    });

    test('onChange() unsubscribe stops further notifications', () => {
        const { store } = makeStore({});
        const listener = jest.fn();
        const unsubscribe = store.onChange(listener);
        store.create('a', {});
        unsubscribe();
        store.create('b', {});
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe('RelationStore', () => {
    // Backed by a plain `{[key]: string[]}` map for test convenience, but - unlike the old dict-backed
    // RelationStore - `resolve()` only returns an array for a key that's already a known entry; it never
    // auto-vivifies one. That mirrors the real wiring (tags.js's resolveTagIdsArray()), where a key only
    // resolves to something if the character/group it names is actually resident.
    function makeStore(initial = { char1: ['tagA', 'tagB'], char2: ['tagB'] }) {
        const map = initial;
        const resolve = (key) => Object.hasOwn(map, key) && Array.isArray(map[key]) ? map[key] : undefined;
        const allEntries = () => Object.entries(map).filter(([, ids]) => Array.isArray(ids));
        return { map, store: new RelationStore(resolve, allEntries) };
    }

    test('get() returns [] for an unknown key rather than undefined', () => {
        const { store } = makeStore({});
        expect(store.get('ghost')).toEqual([]);
    });

    test('constructor derives usage counts from the initial map', () => {
        const { store } = makeStore();
        expect(store.getAssignedIds()).toEqual(new Set(['tagA', 'tagB']));
    });

    test('isAssigned() reflects current assignment', () => {
        const { store } = makeStore();
        expect(store.isAssigned('char1', 'tagA')).toBe(true);
        expect(store.isAssigned('char1', 'tagB')).toBe(true);
        expect(store.isAssigned('char2', 'tagA')).toBe(false);
    });

    test('assign() adds to the key, reports wasFirstUse only on the tag\'s first assignment anywhere', () => {
        const { map, store } = makeStore({ char1: [], char2: [] });
        const listener = jest.fn();
        store.onChange(listener);

        const first = store.assign('char1', 'newTag');
        expect(map.char1).toEqual(['newTag']);
        expect(first).toEqual({ op: 'assigned', key: 'char1', relatedId: 'newTag', wasFirstUse: true });

        const second = store.assign('char2', 'newTag');
        expect(second.wasFirstUse).toBe(false);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    test('assign() is a no-op (returns null, does not emit) for a key that doesn\'t resolve to anything', () => {
        const { store } = makeStore({});
        const listener = jest.fn();
        store.onChange(listener);
        expect(store.assign('brandNew', 'tagX')).toBeNull();
        expect(listener).not.toHaveBeenCalled();
    });

    test('assign() is a no-op (returns null, does not emit) if already assigned', () => {
        const { store } = makeStore({ char1: ['tagA'] });
        const listener = jest.fn();
        store.onChange(listener);
        expect(store.assign('char1', 'tagA')).toBeNull();
        expect(listener).not.toHaveBeenCalled();
    });

    test('unassign() removes from the key, reports wasLastUse only when no assignment remains anywhere', () => {
        const { map, store } = makeStore({ char1: ['tagA'], char2: ['tagA'] });
        const listener = jest.fn();
        store.onChange(listener);

        const first = store.unassign('char1', 'tagA');
        expect(map.char1).toEqual([]);
        expect(first).toEqual({ op: 'unassigned', key: 'char1', relatedId: 'tagA', wasLastUse: false });
        expect(store.getAssignedIds().has('tagA')).toBe(true);

        const second = store.unassign('char2', 'tagA');
        expect(second.wasLastUse).toBe(true);
        expect(store.getAssignedIds().has('tagA')).toBe(false);
    });

    test('unassign() is a no-op if not currently assigned or the key is unknown', () => {
        const { store } = makeStore({ char1: ['tagA'] });
        const listener = jest.fn();
        store.onChange(listener);
        expect(store.unassign('char1', 'tagZ')).toBeNull();
        expect(store.unassign('ghostKey', 'tagA')).toBeNull();
        expect(listener).not.toHaveBeenCalled();
    });

    test('setKey() computes and reports exactly the added/removed delta, and updates usage counts', () => {
        const { map, store } = makeStore({ char1: ['tagA', 'tagB'] });
        const listener = jest.fn();
        store.onChange(listener);

        const change = store.setKey('char1', ['tagB', 'tagC']);
        expect(map.char1).toEqual(['tagB', 'tagC']);
        expect(change).toEqual({ op: 'keySet', key: 'char1', addedIds: ['tagC'], removedIds: ['tagA'] });
        expect(store.getAssignedIds().has('tagA')).toBe(false); // tagA had no other use
        expect(store.getAssignedIds().has('tagC')).toBe(true);
        expect(listener).toHaveBeenCalledWith(change);
    });

    test('setKey() is a no-op for a key that doesn\'t resolve to anything', () => {
        const { store } = makeStore({});
        expect(store.setKey('ghost', ['tagA'])).toBeNull();
    });

    test('removeKey() clears the key\'s assignments in place and reports which related ids lost their last use', () => {
        const { map, store } = makeStore({ char1: ['tagA'], char2: ['tagA', 'tagB'] });
        const change = store.removeKey('char1');
        expect(map.char1).toEqual([]); // cleared, not deleted - there's no separate map entry to drop
        expect(change.op).toBe('keyRemoved');
        expect(change.removedIds).toEqual(['tagA']);
        expect(change.lastUseIds).toEqual([]); // tagA still used by char2
        expect(store.getAssignedIds().has('tagA')).toBe(true);
    });

    test('removeKey() on an unknown key returns null', () => {
        const { store } = makeStore();
        expect(store.removeKey('ghost')).toBeNull();
    });

    test('removeRelatedIdEverywhere() strips the id from every key and drops its usage count', () => {
        const { map, store } = makeStore({ char1: ['tagA', 'tagB'], char2: ['tagA'] });
        const change = store.removeRelatedIdEverywhere('tagA');
        expect(map.char1).toEqual(['tagB']);
        expect(map.char2).toEqual([]);
        expect(change.op).toBe('relatedRemoved');
        expect(change.affectedKeys.sort()).toEqual(['char1', 'char2']);
        expect(store.getAssignedIds().has('tagA')).toBe(false);
    });

    test('removeRelatedIdEverywhere() with replaceWithId substitutes it in wherever removed', () => {
        const { map, store } = makeStore({ char1: ['tagA'], char2: ['tagA', 'tagC'] });
        const change = store.removeRelatedIdEverywhere('tagA', { replaceWithId: 'tagC' });
        expect(map.char1).toEqual(['tagC']);
        expect(map.char2).toEqual(['tagC']); // already had tagC, not duplicated
        expect(change.replacedWithId).toBe('tagC');
        expect(store.getAssignedIds().has('tagC')).toBe(true);
    });

    test('reindex() recomputes usage counts from the current entries without emitting', () => {
        const { map, store } = makeStore({ char1: ['tagA'] });
        map.char1.push('tagB'); // mutate directly, bypassing the store
        const listener = jest.fn();
        store.onChange(listener);
        expect(store.getAssignedIds().has('tagB')).toBe(false); // stale before reindex
        store.reindex();
        expect(store.getAssignedIds().has('tagB')).toBe(true);
        expect(listener).not.toHaveBeenCalled();
    });

    test('onChange() unsubscribe stops further notifications', () => {
        const { store } = makeStore({ k: [] });
        const listener = jest.fn();
        const unsubscribe = store.onChange(listener);
        store.assign('k', 'v');
        unsubscribe();
        store.assign('k', 'v2');
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

/**
 * These mirror the exact store-construction pattern each migrated subsystem uses (same getId functions / backing
 * shapes as tags.js, script.js, group-chats.js, power-user.js), to pin down the invariant each migration actually
 * depends on: a mutation on the store surfaces via onChange() with enough detail that a subscriber needs no
 * before/after diff to know what to invalidate. This doesn't import those modules directly - they pull in the
 * full app entry point (script.js) with DOM/jQuery side effects that aren't set up for node/jest - so this is
 * scoped to the store-wiring contract itself, not a full integration test of e.g. tags.js's DOM handlers.
 */
/**
 * Builds a RelationStore resolver/allEntries pair over a charactersStore + groupsStore, the same as
 * tags.js's resolveTagIdsArray()/allTagIdsEntries() - factored out so the test body itself stays
 * conditional-free (see the module doc comment on `test('tags: ...')` below).
 */
function makeCharGroupTagResolver(charactersStore, groupsStore) {
    function resolve(key) {
        const character = charactersStore.get(key);
        if (character) return character.tag_ids;
        const group = groupsStore.get(key);
        if (group) return group.tag_ids;
        return undefined;
    }
    function* allEntries() {
        for (const c of charactersStore.getAll()) yield [c.avatar, c.tag_ids];
        for (const g of groupsStore.getAll()) yield [String(g.id), g.tag_ids];
    }
    return { resolve, allEntries };
}

describe('migrated-subsystem store wiring', () => {
    test('tags: EntityStore keyed by tag.id + RelationStore resolving straight through to characters\'/groups\' own tag_ids, as wired in tags.js', () => {
        const tags = [{ id: 't1', name: 'Fluffy' }];
        // tags.js has no separate backing map for tagMapStore - it resolves each key to the resident
        // character's/group's own tag_ids array (see resolveTagIdsArray()/allTagIdsEntries()).
        const characters = [{ avatar: 'charAvatar1.png', tag_ids: ['t1'] }];
        const groups = [];
        const charactersStore = new EntityStore(characters, c => c.avatar);
        const groupsStore = new EntityStore(groups, g => g.id);
        const { resolve, allEntries } = makeCharGroupTagResolver(charactersStore, groupsStore);
        const tagsStore = new EntityStore(tags, tag => tag.id);
        const tagMapStore = new RelationStore(resolve, allEntries);

        const tagListener = jest.fn();
        const mapListener = jest.fn();
        tagsStore.onChange(tagListener);
        tagMapStore.onChange(mapListener);

        // deleting a tag's definition and unlinking it everywhere should each fire exactly once, and the
        // unlink should drop 't1' from the assigned-ids set (so a subscriber can drop it from a filter bar).
        tagsStore.remove('t1');
        const unlinkChange = tagMapStore.removeRelatedIdEverywhere('t1');

        expect(tagListener).toHaveBeenCalledTimes(1);
        expect(unlinkChange.affectedKeys).toEqual(['charAvatar1.png']);
        expect(tagMapStore.getAssignedIds().has('t1')).toBe(false);
        expect(characters[0].tag_ids).toEqual([]); // the entity's own array was mutated in place
        expect(mapListener).toHaveBeenCalledWith(expect.objectContaining({ op: 'relatedRemoved', relatedId: 't1' }));
    });

    test('characters: EntityStore keyed by avatar, as wired in script.js', () => {
        const characters = [{ avatar: 'char1.png', name: 'Alice' }];
        const charactersStore = new EntityStore(characters, c => c.avatar);
        const listener = jest.fn();
        charactersStore.onChange(listener);

        // a rename changes the id-bearing field itself - the array is spliced in place by the caller and the
        // store is told about it after the fact via reindex()+reportRenamed(), same as EntityStore.reportRenamed's
        // documented contract for "backing array already rebuilt out from under this store".
        characters[0].avatar = 'char1-renamed.png';
        charactersStore.reindex();
        const change = charactersStore.reportRenamed('char1.png', 'char1-renamed.png');
        expect(change.op).toBe('renamed');
        expect(charactersStore.has('char1-renamed.png')).toBe(true);
        expect(charactersStore.has('char1.png')).toBe(false);
        expect(listener).toHaveBeenCalledWith(change);
    });

    test('groups: EntityStore keyed by group.id, as wired in group-chats.js', () => {
        const groups = [{ id: 'g1', members: [] }];
        const groupsStore = new EntityStore(groups, g => g.id);
        const listener = jest.fn();
        groupsStore.onChange(listener);
        const change = groupsStore.update('g1', { members: ['char1.png'] });
        expect(change.patch).toEqual({ members: ['char1.png'] });
        expect(groups[0].members).toEqual(['char1.png']);
        expect(listener).toHaveBeenCalledWith(change);
    });

    test('personas: DictEntityStore over persona_data, as wired in power-user.js', () => {
        const persona_data = { 'user1.png': { name: 'User One' } };
        const personaStore = new DictEntityStore(persona_data);
        const listener = jest.fn();
        personaStore.onChange(listener);

        // a persona avatar rename must move the entry under the store's rename(), not a delete+create pair -
        // otherwise a subscriber keyed on 'created'/'removed' would treat it as losing then gaining a persona.
        const change = personaStore.rename('user1.png', 'user1-renamed.png');
        expect(change.op).toBe('renamed');
        expect(Object.hasOwn(persona_data, 'user1.png')).toBe(false);
        expect(persona_data['user1-renamed.png']).toEqual({ name: 'User One' });
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
