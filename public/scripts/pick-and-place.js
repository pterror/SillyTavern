/**
 * Shared pick-and-place reordering for a rendered list. The picked item is held by its key in the instance, never
 * read back from the DOM, so filtering and re-rendering can't lose or misplace it. Every insertion slot is built with
 * its click handler attached, so slots recreated by refresh() work the same as the first ones. The helper only reports
 * "move X before or after Y" by key; the caller decides what that means and what happens after it.
 */

/**
 * @typedef {object} PickAndPlaceItem
 * @property {any} key - the item's identity, compared with `===`
 * @property {HTMLElement} element - the item's rendered element
 * @property {boolean} visible - false when the item is hidden (e.g. by a filter)
 */

/**
 * @typedef {object} PickAndPlaceMove
 * @property {any} key - the picked item's key
 * @property {'before'|'after'} side - which side of the anchor the item goes to
 * @property {any} anchorKey - the key of the item it is placed next to
 */

/**
 * @typedef {object} PickAndPlaceOptions
 * @property {HTMLElement} container - gets class `pick-place-active` while an item is picked
 * @property {() => PickAndPlaceItem[]} getItems - every item, in list order, hidden ones included
 * @property {(move: PickAndPlaceMove) => void} onPlace - called when a slot is clicked
 * @property {(key: any|null) => void} [onPickChange] - called after pick() and after cancel()
 */

export class PickAndPlace {
    /** @param {PickAndPlaceOptions} options */
    constructor({ container, getItems, onPlace, onPickChange }) {
        this.container = container;
        this.getItems = getItems;
        this.onPlace = onPlace;
        this.onPickChange = onPickChange;
        /** @type {any|null} null when nothing is picked */
        this.pickedKey = null;
        /** @type {HTMLElement[]} Only the slots this instance created, so removal never touches anyone else's. */
        this.slots = [];
    }

    /** @param {any} key */
    pick(key) {
        if (this.pickedKey !== null) {
            this.cancel();
        }
        this.pickedKey = key;
        this.container.classList.add('pick-place-active');
        this.refresh();
        this.onPickChange?.(key);
    }

    cancel() {
        this.removeSlots();
        for (const item of this.getItems()) {
            item.element.classList.remove('pick-place-picked');
        }
        this.container.classList.remove('pick-place-active');
        this.pickedKey = null;
        this.onPickChange?.(null);
    }

    /**
     * Rebuilds the slots from the current items. Slots next to the picked item are skipped by its neighbours in the
     * full list, hidden ones included, so a filter can't expose a slot that would leave the item where it is.
     */
    refresh() {
        this.removeSlots();
        if (this.pickedKey === null) {
            return;
        }

        const pickedKey = this.pickedKey;
        const items = this.getItems();
        const pickedIndex = items.findIndex(item => item.key === pickedKey);
        if (pickedIndex === -1) {
            this.cancel();
            return;
        }

        for (const item of items) {
            if (item.key === pickedKey) {
                item.element.classList.add('pick-place-picked');
            } else {
                item.element.classList.remove('pick-place-picked');
            }
        }

        const next = items[pickedIndex + 1];
        /** @type {PickAndPlaceItem|null} */
        let lastVisible = null;
        for (const item of items) {
            if (!item.visible) {
                continue;
            }
            lastVisible = item;
            if (item.key === pickedKey || (next !== undefined && next.key === item.key)) {
                continue;
            }
            item.element.before(this.createSlot('before', item.key));
        }

        if (lastVisible === null) {
            return;
        }
        const last = items[items.length - 1];
        if (last.key !== pickedKey) {
            lastVisible.element.after(this.createSlot('after', last.key));
        }
    }

    /**
     * The only place slots are built, so every slot, recreated ones included, carries its click handler.
     * @param {'before'|'after'} side
     * @param {any} anchorKey
     * @returns {HTMLDivElement}
     */
    createSlot(side, anchorKey) {
        const key = this.pickedKey;
        const slot = document.createElement('div');
        slot.className = 'pick-place-slot';
        slot.addEventListener('click', () => {
            this.onPlace({ key, side, anchorKey });
        });
        this.slots.push(slot);
        return slot;
    }

    removeSlots() {
        for (const slot of this.slots) {
            slot.remove();
        }
        this.slots = [];
    }
}
