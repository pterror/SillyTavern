import { EntityStore } from './entity-store.js';

/** @type {Group[]} */
export let groups = [];
/**
 * `groups` is reassigned to a new array reference on every getGroups() refetch rather than spliced in place,
 * so `groupsStore` has to be rebuilt (rebuildGroupsStoreCore()) each time rather than just wrapping it once.
 * @type {EntityStore<Group>}
 */
export let groupsStore = new EntityStore(groups, g => g.id);

/** Reassigns `groups` to a new array reference. @param {Group[]} newGroups */
export function setGroups(newGroups) {
    groups = newGroups;
}

/** Rebuilds `groupsStore` to wrap the current `groups` reference. @returns {EntityStore<Group>} */
export function rebuildGroupsStoreCore() {
    groupsStore = new EntityStore(groups, g => g.id);
    return groupsStore;
}
