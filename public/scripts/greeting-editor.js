import { callGenericPopup, POPUP_TYPE } from './popup.js';

export class GreetingEditor {
    /**
     * @param {HTMLElement} containerElement
     */
    constructor(containerElement) {
        this.container = containerElement;
        this.greetings = [];
        this.pickedIndex = null;
        this.filterText = '';
        this.expandedIndices = new Set();

        this._buildShell();
    }

    /**
     * Populate the editor from character data.
     * @param {string} firstMes
     * @param {string[]} alternateGreetings
     */
    setGreetings(firstMes, alternateGreetings) {
        this.greetings = [firstMes ?? '', ...(alternateGreetings ?? [])];
        this.pickedIndex = null;
        this.filterText = '';
        this.expandedIndices.clear();
        this.filterInput.value = '';
        this.render();
    }

    /** @returns {string} */
    getFirstMes() {
        return this.greetings[0] ?? '';
    }

    /** @returns {string[]} */
    getAlternateGreetings() {
        return this.greetings.slice(1);
    }

    clear() {
        this.greetings = [];
        this.pickedIndex = null;
        this.filterText = '';
        this.expandedIndices.clear();
        this.filterInput.value = '';
        this.render();
    }

    destroy() {
        this._destroySortable();
        this.container.innerHTML = '';
    }

    // ── internal ──

    _buildShell() {
        this.container.innerHTML = '';
        this.container.classList.add('greeting-editor');

        // filter input
        this.filterInput = document.createElement('input');
        this.filterInput.type = 'text';
        this.filterInput.placeholder = 'Filter greetings...';
        this.filterInput.classList.add('text_pole', 'greeting-filter-input');
        this.filterInput.addEventListener('input', () => {
            this.filterText = this.filterInput.value;
            this.render();
        });
        this.container.appendChild(this.filterInput);

        // status bar
        this.statusBar = document.createElement('div');
        this.statusBar.classList.add('greeting-status-bar');
        this.statusBar.style.display = 'none';
        this.container.appendChild(this.statusBar);

        // rows list
        this.rowsList = document.createElement('div');
        this.rowsList.classList.add('greeting-rows-list');
        this.container.appendChild(this.rowsList);

        // add button
        const addBtn = document.createElement('button');
        addBtn.classList.add('menu_button', 'greeting-add-btn');
        addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add Greeting';
        addBtn.addEventListener('click', () => this._addGreeting());
        this.container.appendChild(addBtn);

        this.render();
    }

    /** Get the array indices that pass the current filter. */
    _getVisibleIndices() {
        const filter = this.filterText.toLowerCase();
        const indices = [];
        for (let i = 0; i < this.greetings.length; i++) {
            if (!filter || this.greetings[i].toLowerCase().includes(filter)) {
                indices.push(i);
            }
        }
        return indices;
    }

    render() {
        const visibleIndices = this._getVisibleIndices();

        // status bar
        if (this.pickedIndex !== null && !visibleIndices.includes(this.pickedIndex)) {
            const preview = this.greetings[this.pickedIndex] ?? '';
            const truncated = preview.length > 40 ? preview.slice(0, 40) + '...' : preview;
            this.statusBar.textContent = `Moving: #${this.pickedIndex + 1} ${truncated}`;
            this.statusBar.style.display = '';
        } else {
            this.statusBar.style.display = 'none';
        }

        // clear rows
        this._destroySortable();
        this.rowsList.innerHTML = '';

        // build rows with insertion points
        for (let vi = 0; vi < visibleIndices.length; vi++) {
            const idx = visibleIndices[vi];

            // insertion point before this row
            if (this.pickedIndex !== null) {
                const prevIdx = vi > 0 ? visibleIndices[vi - 1] : null;
                // don't show insertion points adjacent to the picked greeting
                if (idx !== this.pickedIndex && prevIdx !== this.pickedIndex) {
                    // "top of list" when vi === 0, otherwise "between prevIdx and idx"
                    const insertPos = vi === 0 ? 0 : prevIdx + 1;
                    this.rowsList.appendChild(this._createInsertionPoint(insertPos));
                }
            }

            this.rowsList.appendChild(this._createRow(idx));
        }

        // insertion point after last row
        if (this.pickedIndex !== null && visibleIndices.length > 0) {
            const lastIdx = visibleIndices[visibleIndices.length - 1];
            if (lastIdx !== this.pickedIndex) {
                this.rowsList.appendChild(this._createInsertionPoint(this.greetings.length));
            }
        }

        // also handle empty visible list but picked index exists
        if (this.pickedIndex !== null && visibleIndices.length === 0) {
            this.rowsList.appendChild(this._createInsertionPoint(0));
        }

        this._initSortable();
    }

    /**
     * @param {number} idx - array index
     * @returns {HTMLElement}
     */
    _createRow(idx) {
        const greeting = this.greetings[idx];
        const isDefault = idx === 0;
        const isPicked = this.pickedIndex === idx;
        const isExpanded = this.expandedIndices.has(idx);

        const row = document.createElement('div');
        row.classList.add('greeting-row');
        row.dataset.greetingIndex = String(idx);
        if (isPicked) row.classList.add('greeting-picked');
        if (isDefault) row.classList.add('greeting-default');

        // drag handle
        const handle = document.createElement('span');
        handle.classList.add('greeting-drag-handle');
        handle.innerHTML = '<i class="fa-solid fa-grip-vertical"></i>';
        row.appendChild(handle);

        // index
        const indexSpan = document.createElement('span');
        indexSpan.classList.add('greeting-row-index');
        indexSpan.textContent = `#${idx + 1}`;
        row.appendChild(indexSpan);

        // default badge
        if (isDefault) {
            const badge = document.createElement('span');
            badge.classList.add('greeting-default-badge');
            badge.textContent = 'default';
            row.appendChild(badge);
        }

        // preview
        const preview = document.createElement('span');
        preview.classList.add('greeting-row-preview');
        const previewText = greeting.length > 80 ? greeting.slice(0, 80) + '...' : greeting;
        preview.textContent = previewText || '(empty)';
        row.appendChild(preview);

        // actions
        const actions = document.createElement('span');
        actions.classList.add('greeting-row-actions');

        // expand/collapse
        const expandBtn = document.createElement('button');
        expandBtn.classList.add('menu_button', 'greeting-row-action-btn');
        expandBtn.innerHTML = `<i class="fa-solid ${isExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>`;
        expandBtn.title = isExpanded ? 'Collapse' : 'Expand';
        expandBtn.addEventListener('click', () => {
            if (this.expandedIndices.has(idx)) {
                this.expandedIndices.delete(idx);
            } else {
                this.expandedIndices.add(idx);
            }
            this.render();
        });
        actions.appendChild(expandBtn);

        // pick / cancel pick
        const pickBtn = document.createElement('button');
        pickBtn.classList.add('menu_button', 'greeting-row-action-btn');
        if (isPicked) {
            pickBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            pickBtn.title = 'Cancel move';
            pickBtn.addEventListener('click', () => {
                this.pickedIndex = null;
                this.render();
            });
        } else {
            pickBtn.innerHTML = '<i class="fa-solid fa-arrows-up-down"></i>';
            pickBtn.title = 'Pick up to move';
            pickBtn.addEventListener('click', () => {
                this.pickedIndex = idx;
                this.render();
            });
        }
        actions.appendChild(pickBtn);

        // set as default (only for non-first)
        if (!isDefault) {
            const starBtn = document.createElement('button');
            starBtn.classList.add('menu_button', 'greeting-row-action-btn');
            starBtn.innerHTML = '<i class="fa-solid fa-star"></i>';
            starBtn.title = 'Set as default greeting';
            starBtn.addEventListener('click', () => {
                this._moveGreeting(idx, 0);
            });
            actions.appendChild(starBtn);
        }

        // delete
        const deleteBtn = document.createElement('button');
        deleteBtn.classList.add('menu_button', 'greeting-row-action-btn');
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        deleteBtn.title = 'Delete greeting';
        deleteBtn.addEventListener('click', () => this._deleteGreeting(idx));
        actions.appendChild(deleteBtn);

        row.appendChild(actions);

        // expanded textarea
        if (isExpanded) {
            const expandedArea = document.createElement('div');
            expandedArea.classList.add('greeting-row-expanded');

            const textarea = document.createElement('textarea');
            textarea.classList.add('text_pole', 'mdHotkeys');
            textarea.setAttribute('data-macros', '');
            textarea.value = greeting;
            textarea.rows = 6;
            textarea.addEventListener('input', () => {
                this.greetings[idx] = textarea.value;
            });

            expandedArea.appendChild(textarea);
            row.appendChild(expandedArea);
        }

        return row;
    }

    /**
     * @param {number} insertPos - position in the underlying array to insert at
     * @returns {HTMLElement}
     */
    _createInsertionPoint(insertPos) {
        const point = document.createElement('div');
        point.classList.add('greeting-insertion-point');

        const label = document.createElement('span');
        label.classList.add('greeting-insertion-label');
        label.textContent = 'insert here';
        point.appendChild(label);

        point.addEventListener('click', () => {
            if (this.pickedIndex === null) return;
            this._moveGreeting(this.pickedIndex, insertPos);
            this.pickedIndex = null;
            this.render();
        });

        return point;
    }

    /**
     * Move a greeting from one index to another.
     * @param {number} fromIdx
     * @param {number} toIdx - target position (before removal adjustment)
     */
    _moveGreeting(fromIdx, toIdx) {
        const [greeting] = this.greetings.splice(fromIdx, 1);
        // adjust target if it was after the removed element
        const adjustedTo = toIdx > fromIdx ? toIdx - 1 : toIdx;
        this.greetings.splice(adjustedTo, 0, greeting);

        // update expanded indices
        const newExpanded = new Set();
        for (const oldIdx of this.expandedIndices) {
            if (oldIdx === fromIdx) {
                newExpanded.add(adjustedTo);
            } else {
                // figure out the new index after the move
                let newIdx = oldIdx;
                if (oldIdx > fromIdx) newIdx--;
                if (newIdx >= adjustedTo) newIdx++;
                newExpanded.add(newIdx);
            }
        }
        this.expandedIndices = newExpanded;

        this.pickedIndex = null;
        this.render();
    }

    async _deleteGreeting(idx) {
        const preview = this.greetings[idx].length > 60
            ? this.greetings[idx].slice(0, 60) + '...'
            : (this.greetings[idx] || '(empty)');

        const result = await callGenericPopup(
            `Delete greeting #${idx + 1}?\n\n"${preview}"`,
            POPUP_TYPE.CONFIRM,
        );

        if (result) {
            this.greetings.splice(idx, 1);
            this.expandedIndices.delete(idx);

            // shift expanded indices
            const newExpanded = new Set();
            for (const oldIdx of this.expandedIndices) {
                if (oldIdx > idx) {
                    newExpanded.add(oldIdx - 1);
                } else {
                    newExpanded.add(oldIdx);
                }
            }
            this.expandedIndices = newExpanded;

            if (this.pickedIndex !== null) {
                if (this.pickedIndex === idx) {
                    this.pickedIndex = null;
                } else if (this.pickedIndex > idx) {
                    this.pickedIndex--;
                }
            }

            this.render();
        }
    }

    _addGreeting() {
        this.greetings.push('');
        const newIdx = this.greetings.length - 1;
        this.expandedIndices.add(newIdx);
        this.render();

        // scroll to bottom
        this.rowsList.scrollTop = this.rowsList.scrollHeight;
    }

    _initSortable() {
        if (this.pickedIndex !== null) return;

        try {
            $(this.rowsList).sortable({
                handle: '.greeting-drag-handle',
                items: '.greeting-row',
                placeholder: 'greeting-sortable-placeholder',
                tolerance: 'pointer',
                update: (_event, _ui) => {
                    // read new order from DOM
                    const newOrder = [];
                    $(this.rowsList).find('.greeting-row').each((_i, el) => {
                        newOrder.push(Number(el.dataset.greetingIndex));
                    });

                    // rebuild greetings array
                    const reordered = newOrder.map(i => this.greetings[i]);

                    // rebuild expanded indices
                    const newExpanded = new Set();
                    for (let newPos = 0; newPos < newOrder.length; newPos++) {
                        if (this.expandedIndices.has(newOrder[newPos])) {
                            newExpanded.add(newPos);
                        }
                    }

                    this.greetings = reordered;
                    this.expandedIndices = newExpanded;

                    // re-render to sync indices
                    this.render();
                },
            });
        } catch {
            // jQuery UI not available
        }
    }

    _destroySortable() {
        try {
            if ($(this.rowsList).sortable('instance')) {
                $(this.rowsList).sortable('destroy');
            }
        } catch {
            // not initialized
        }
    }
}
