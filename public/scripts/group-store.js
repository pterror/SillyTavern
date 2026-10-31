import { EntityStore } from './entity-store.js';

/** @type {Group[]} */
export let groups = [];
/** @type {EntityStore<Group>} */
export let groupsStore = new EntityStore(groups, g => g.id);

/** @param {Group[]} newGroups */
export function setGroups(newGroups) {
    groups = newGroups;
}

/** @returns {EntityStore<Group>} */
export function rebuildGroupsStoreCore() {
    groupsStore = new EntityStore(groups, g => g.id);
    return groupsStore;
}
