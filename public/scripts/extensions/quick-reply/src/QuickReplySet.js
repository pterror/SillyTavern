import { getRequestHeaders, substituteParams } from '../../../../script.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { executeSlashCommandsOnChatInput, executeSlashCommandsWithOptions } from '../../../slash-commands.js';
import { SlashCommandScope } from '../../../slash-commands/SlashCommandScope.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { warn } from '../index.js';
import { QuickReply } from './QuickReply.js';

export class QuickReplySet {
    /**@type {QuickReplySet[]}*/ static list = [];

    /**
     * @param {Partial<QuickReplySet>} props
     * @returns {QuickReplySet}
     */
    static from(props) {
        props.qrList = []; //props.qrList?.map(it=>QuickReply.from(it));
        const instance = Object.assign(new this(), props);
        // instance.init();
        return instance;
    }

    /**
     * @param {string} name - name of the QuickReplySet
     */
    static get(name) {
        return this.list.find(it => it.name == name);
    }

    /**@type {string}*/ name;
    /**@type {'global'|'chat'|'character'}*/ scope = 'global';
    /**@type {boolean}*/ disableSend = false;
    /**@type {boolean}*/ placeBeforeInput = false;
    /**@type {boolean}*/ injectInput = false;
    /**@type {string}*/ color = 'transparent';
    /**@type {boolean}*/ onlyBorderColor = false;
    /**@type {QuickReply[]}*/ qrList = [];
    /**@type {number}*/ idIndex = 0;
    /**@type {boolean}*/ isDeleted = false;
    /**@type {HTMLElement}*/ dom;
    /**@type {HTMLElement}*/ settingsDom;

    /**
     * Per-QR-entry debounce timers, used ONLY to coalesce a single CONTINUOUS edit (e.g. typing
     * into a label/message/title field, one 'input' event per keystroke) into one request once
     * the edit settles - matching this codebase's messageEditAuto/saveChatDebounced precedent for
     * textarea auto-save. Every other user action (add, delete, reorder, a set-level property
     * toggle, or a discrete per-entry change like an icon pick or checkbox click) is a single,
     * instantaneous gesture and is dispatched to the server immediately, with no accumulation
     * across separate actions - see performSave's removal and the design note above performSave's
     * former call sites for the reasoning.
     * @type {Map<number, ReturnType<typeof setTimeout>>}
     */
    _qrUpdateTimers = new Map();

    /**
     * Low-level immediate dispatch to /save-partial. Every save*() method below builds its own
     * one-shot payload for exactly the ONE user action it represents, instead of accumulating
     * multiple distinct actions into one shared, debounced bundle. The server route already
     * applies each bucket (setProps/qrUpdates/qrAdds/qrDeletes/qrOrder) as a named op against its
     * own stored state, so nothing stops a caller from populating more than one bucket in a single
     * call when a single action genuinely has multiple facets (e.g. adding a QR also bumps
     * idIndex - see saveQrAdd) - the requirement is "one real user action -> one request", not
     * "one bucket -> one request".
     */
    async _dispatchSave(partial) {
        const response = await fetch('/api/quick-replies/save-partial', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: this.name, ...partial }),
        });

        if (response.ok) {
            this.rerender();
            return response.json().catch(() => null);
        } else {
            warn(`Failed to save Quick Reply Set: ${this.name}`);
            console.error('QR could not be saved', response);
            return null;
        }
    }

    /** Save a changed set-level property (color, disableSend, etc.) - a single discrete action, dispatched immediately. */
    saveSetProp(prop, value) {
        return this._dispatchSave({ setProps: { [prop]: value } });
    }

    /**
     * Save a changed QR entry (full entry, merged by stable id).
     * @param {QuickReply} qr the changed entry
     * @param {boolean} [immediate] true (default) for a single discrete action (an icon pick, a
     *   checkbox click, a context-menu toggle) - dispatched right away. false for a CONTINUOUS,
     *   in-progress edit (typing into a text field, one call per keystroke) - coalesced via a
     *   per-entry debounce so a whole burst of keystrokes to the SAME entry becomes one request
     *   once typing settles, without ever merging with a different entry or a different kind of
     *   action.
     */
    saveQrUpdate(qr, immediate = true) {
        if (immediate) {
            clearTimeout(this._qrUpdateTimers.get(qr.id));
            this._qrUpdateTimers.delete(qr.id);
            return this._dispatchSave({ qrUpdates: [qr] });
        }
        clearTimeout(this._qrUpdateTimers.get(qr.id));
        this._qrUpdateTimers.set(qr.id, setTimeout(() => {
            this._qrUpdateTimers.delete(qr.id);
            this._dispatchSave({ qrUpdates: [qr] });
        }, 300));
    }

    /**
     * Save a new QR entry addition - a single discrete action. idIndex is bumped as part of the
     * very same action (not a separate one), so it's sent in the same request.
     */
    saveQrAdd(qr) {
        return this._dispatchSave({ qrAdds: [qr], setProps: { idIndex: this.idIndex } });
    }

    /** Save a QR entry deletion by stable id - a single discrete action, dispatched immediately. */
    saveQrDelete(id) {
        clearTimeout(this._qrUpdateTimers.get(id));
        this._qrUpdateTimers.delete(id);
        return this._dispatchSave({ qrDeletes: [id] });
    }

    /**
     * Save a reorder of QR entries - a drag-and-drop (or insert-before) reorder is ONE user action
     * even though it touches every item's position, so it's legitimately sent as one bulk request
     * with the whole new order, matching tags.js's saveTagsNow() precedent for its own drag-reorder
     * case.
     */
    saveOrder() {
        return this._dispatchSave({ qrOrder: this.qrList.map(qr => qr.id) });
    }

    init() {
        this.qrList.forEach(qr => this.hookQuickReply(qr));
    }

    unrender() {
        this.dom?.remove();
        this.dom = null;
    }
    render() {
        this.unrender();
        if (!this.dom) {
            const root = document.createElement('div'); {
                this.dom = root;
                root.classList.add('qr--buttons');
                this.updateColor();
                this.qrList.filter(qr => !qr.isHidden).forEach(qr => {
                    root.append(qr.render());
                });
            }
        }
        return this.dom;
    }
    rerender() {
        if (!this.dom) return;
        this.dom.innerHTML = '';
        this.qrList.filter(qr => !qr.isHidden).forEach(qr => {
            this.dom.append(qr.render());
        });
    }
    updateColor() {
        if (!this.dom) return;
        if (this.color && this.color != 'transparent' && this.color != 'rgba(0, 0, 0, 0)') {
            this.dom.style.setProperty('--qr--color', this.color);
            this.dom.classList.add('qr--color');
            if (this.onlyBorderColor) {
                this.dom.classList.add('qr--borderColor');
            } else {
                this.dom.classList.remove('qr--borderColor');
            }
        } else {
            this.dom.style.setProperty('--qr--color', 'transparent');
            this.dom.classList.remove('qr--color');
            this.dom.classList.remove('qr--borderColor');
        }
    }

    renderSettings() {
        if (!this.settingsDom) {
            this.settingsDom = document.createElement('div'); {
                this.settingsDom.classList.add('qr--set-qrListContents');
                this.qrList.forEach((qr, idx) => {
                    this.renderSettingsItem(qr, idx);
                });
            }
        }
        return this.settingsDom;
    }
    /**
     *
     * @param {QuickReply} qr
     * @param {number} idx
     */
    renderSettingsItem(qr, idx) {
        this.settingsDom.append(qr.renderSettings(idx));
    }

    /**
     *
     * @param {QuickReply} qr
     */
    async debug(qr) {
        const parser = new SlashCommandParser();
        const closure = parser.parse(qr.message, true, [], qr.abortController, qr.debugController);
        closure.source = `${this.name}.${qr.label}`;
        closure.onProgress = (done, total) => qr.updateEditorProgress(done, total);
        closure.scope.setMacro('arg::*', '');
        return (await closure.execute())?.pipe;
    }

    /**
     *
     * @param {QuickReply} qr The QR to execute.
     * @param {object} options
     * @param {string} [options.message] (null) altered message to be used
     * @param {boolean} [options.isAutoExecute] (false) whether the execution is triggered by auto execute
     * @param {boolean} [options.isEditor] (false) whether the execution is triggered by the QR editor
     * @param {boolean} [options.isRun] (false) whether the execution is triggered by /run or /: (window.executeQuickReplyByName)
     * @param {SlashCommandScope} [options.scope] (null) scope to be used when running the command
     * @param {import('../../../slash-commands.js').ExecuteSlashCommandsOptions} [options.executionOptions] ({}) further execution options
     * @returns
     */
    async executeWithOptions(qr, options = {}) {
        options = Object.assign({
            message: null,
            isAutoExecute: false,
            isEditor: false,
            isRun: false,
            scope: null,
            executionOptions: {},
        }, options);
        const execOptions = options.executionOptions;
        /**@type {HTMLTextAreaElement}*/
        const ta = document.querySelector('#send_textarea');
        const finalMessage = options.message ?? qr.message;
        let input = ta.value;
        if (!options.isAutoExecute && !options.isEditor && !options.isRun && this.injectInput && input.length > 0) {
            if (this.placeBeforeInput) {
                input = `${finalMessage} ${input}`;
            } else {
                input = `${input} ${finalMessage}`;
            }
        } else {
            input = `${finalMessage} `;
        }

        if (input[0] == '/' && !this.disableSend) {
            let result;
            if (options.isAutoExecute || options.isRun) {
                result = await executeSlashCommandsWithOptions(input, Object.assign(execOptions, {
                    handleParserErrors: true,
                    scope: options.scope,
                    source: `${this.name}.${qr.label}`,
                }));
            } else if (options.isEditor) {
                result = await executeSlashCommandsWithOptions(input, Object.assign(execOptions, {
                    handleParserErrors: false,
                    scope: options.scope,
                    abortController: qr.abortController,
                    source: `${this.name}.${qr.label}`,
                    onProgress: (done, total) => qr.updateEditorProgress(done, total),
                }));
            } else {
                result = await executeSlashCommandsOnChatInput(input, Object.assign(execOptions, {
                    scope: options.scope,
                    source: `${this.name}.${qr.label}`,
                }));
            }
            return typeof result === 'object' ? result?.pipe : '';
        }

        ta.value = substituteParams(input);
        ta.focus();

        if (!this.disableSend) {
            // @ts-ignore
            document.querySelector('#send_but').click();
        }
    }

    /**
     * @param {QuickReply} qr
     * @param {string} [message] - optional altered message to be used
     * @param {SlashCommandScope} [scope] - optional scope to be used when running the command
     */
    async execute(qr, message = null, isAutoExecute = false, scope = null) {
        return this.executeWithOptions(qr, {
            message,
            isAutoExecute,
            scope,
        });
    }

    registerNewQuickReply(qr) {
        this.qrList.push(qr);
        this.hookQuickReply(qr);
        if (this.settingsDom) {
            this.renderSettingsItem(qr, this.qrList.length - 1);
        }
        if (this.dom) {
            this.dom.append(qr.render());
        }
    }

    /**
     * Adds a quick reply with a client-picked id, only ever asserted, never confirmed by the
     * server. Prefer addQuickReplyRemote() in new code - it blocks on a network round trip but
     * lets the server mint the id, so it can never collide with an id another tab/client is
     * concurrently minting for the same set.
     *
     * The new-quick-reply-set creation flow (SettingsUi.js's addQrSet()) used to be the one
     * legitimate synchronous case here ("the whole set, including this id, is about to be saved
     * atomically right after"), but that flow was changed to performFullSave() the (empty) set
     * first and then addQuickReplyRemote() the first entry against the now-real, server-confirmed
     * set - so it no longer needs a client-picked id at all. The two cases that remain genuinely
     * synchronous:
     *   1. QuickReplyApi.createQuickReply() - a public, documented, synchronous extension API
     *      (`@returns {QuickReply}`, not a Promise) that existing third-party callers may depend
     *      on getting the new entry back immediately. Changing its return type would be a breaking
     *      API change out of scope here; createQuickReplyRemoteAsync() already exists alongside it
     *      as the recommended async alternative for new callers.
     *   2. onInsertBefore below - inserting a QR before another is one user action with two facets
     *      (mint the entry, place it at a specific position) that must land in a single combined
     *      request; the id has to be known synchronously to build that request's qrOrder list.
     * @param {object} [data]
     * @param {object} [options]
     * @param {boolean} [options.dispatch] (true) whether to persist the addition right away. Pass
     *   false when the caller is about to immediately supersede or combine this with another
     *   request for the SAME user action (e.g. onInsertBefore's combined add+reposition request) -
     *   firing an immediate add here as well would either race the follow-up request or double up
     *   on what is really a single action.
     */
    addQuickReply(data = {}, { dispatch = true } = {}) {
        const id = Math.max(this.idIndex, this.qrList.reduce((max, qr) => Math.max(max, qr.id), 0)) + 1;
        data.id = this.idIndex = id + 1;
        const qr = QuickReply.from(data);
        this.registerNewQuickReply(qr);
        if (dispatch) this.saveQrAdd(qr);
        return qr;
    }

    /**
     * Like addQuickReply(), but waits for the server to mint the id instead of computing one
     * client-side. Blocks on a network round trip - the correct choice whenever a QR is being
     * added to an already-persisted set on its own, outside of a brand new set's atomic save.
     * @param {object} [data]
     * @returns {Promise<QuickReply>}
     */
    async addQuickReplyRemote(data = {}) {
        delete data.id;
        const response = await fetch('/api/quick-replies/save-partial', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: this.name, qrAdds: [data] }),
        });
        if (!response.ok) {
            throw new Error('Failed to create quick reply');
        }
        const result = await response.json();
        data.id = result.assignedIds?.[0];
        this.idIndex = Math.max(this.idIndex, data.id ?? 0);
        const qr = QuickReply.from(data);
        this.registerNewQuickReply(qr);
        return qr;
    }

    async addQuickReplyFromText(qrJson, { remote = false, dispatch = true } = {}) {
        let data;
        if (qrJson) {
            try {
                data = JSON.parse(qrJson ?? '{}');
                delete data.id;
            } catch {
                // not JSON data
            }
            if (data) {
                if (data.label === undefined || data.message === undefined) {
                    toastr.error('Not a QR.');
                    return;
                }
            } else {
                data = { message: qrJson };
            }
        } else {
            data = {};
        }
        const newQr = remote ? await this.addQuickReplyRemote(data) : this.addQuickReply(data, { dispatch });
        return newQr;
    }

    /**
     *
     * @param {QuickReply} qr
     */
    hookQuickReply(qr) {
        // @ts-ignore
        qr.onDebug = () => this.debug(qr);
        qr.onExecute = (_, options) => this.executeWithOptions(qr, options);
        qr.onDelete = () => this.removeQuickReply(qr);
        qr.onUpdate = (qr, options) => this.saveQrUpdate(qr, options?.immediate ?? true);
        qr.onInsertBefore = async (qrJson) => {
            // "Insert a QR before this one" is a single user action with two facets - minting the
            // new entry and placing it at a specific position - that both need to land in the SAME
            // request: dispatching the add on its own first (as addQuickReplyFromText would do by
            // default) and the reorder a moment later would race two independent requests against
            // the same stored file. So the add is created locally without dispatching (dispatch:
            // false), repositioned, and then both facets are sent together in one call.
            const newQr = await this.addQuickReplyFromText(qrJson, { dispatch: false });
            if (!newQr) return;
            this.qrList.splice(this.qrList.indexOf(newQr), 1);
            this.qrList.splice(this.qrList.indexOf(qr), 0, newQr);
            if (qr.settingsDom) {
                qr.settingsDom.insertAdjacentElement('beforebegin', newQr.settingsDom);
            }
            this._dispatchSave({
                qrAdds: [newQr],
                setProps: { idIndex: this.idIndex },
                qrOrder: this.qrList.map(q => q.id),
            });
        };
        qr.onTransfer = async () => {
            /**@type {HTMLSelectElement} */
            let sel;
            let isCopy = false;
            const dom = document.createElement('div'); {
                dom.classList.add('qr--transferModal');
                const title = document.createElement('h3'); {
                    title.textContent = 'Transfer Quick Reply';
                    dom.append(title);
                }
                const subTitle = document.createElement('h4'); {
                    const entryName = qr.label;
                    const bookName = this.name;
                    subTitle.textContent = `${bookName}: ${entryName}`;
                    dom.append(subTitle);
                }
                sel = document.createElement('select'); {
                    sel.classList.add('qr--transferSelect');
                    sel.setAttribute('autofocus', '1');
                    const noOpt = document.createElement('option'); {
                        noOpt.value = '';
                        noOpt.textContent = '-- Select QR Set --';
                        sel.append(noOpt);
                    }
                    for (const qrs of QuickReplySet.list) {
                        const opt = document.createElement('option'); {
                            opt.value = qrs.name;
                            opt.textContent = qrs.name;
                            sel.append(opt);
                        }
                    }
                    sel.addEventListener('keyup', (evt) => {
                        if (evt.key == 'Shift') {
                            // @ts-ignore
                            (dlg.dom ?? dlg.dlg).classList.remove('qr--isCopy');
                            return;
                        }
                    });
                    sel.addEventListener('keydown', (evt) => {
                        if (evt.key == 'Shift') {
                            // @ts-ignore
                            (dlg.dom ?? dlg.dlg).classList.add('qr--isCopy');
                            return;
                        }
                        if (!evt.ctrlKey && !evt.altKey && evt.key == 'Enter') {
                            evt.preventDefault();
                            if (evt.shiftKey) isCopy = true;
                            dlg.completeAffirmative();
                        }
                    });
                    dom.append(sel);
                }
                const hintP = document.createElement('p'); {
                    const hint = document.createElement('small'); {
                        hint.textContent = 'Type or arrows to select QR Set. Enter to transfer. Shift+Enter to copy.';
                        hintP.append(hint);
                    }
                    dom.append(hintP);
                }
            }
            const dlg = new Popup(dom, POPUP_TYPE.CONFIRM, null, { okButton: 'Transfer', cancelButton: 'Cancel' });
            const copyBtn = document.createElement('div'); {
                copyBtn.classList.add('qr--copy');
                copyBtn.classList.add('menu_button');
                copyBtn.textContent = 'Copy';
                copyBtn.addEventListener('click', () => {
                    isCopy = true;
                    dlg.completeAffirmative();
                });
                // @ts-ignore
                (dlg.ok ?? dlg.okButton).insertAdjacentElement('afterend', copyBtn);
            }
            const prom = dlg.show();
            sel.focus();
            await prom;
            if (dlg.result == POPUP_RESULT.AFFIRMATIVE) {
                const qrs = QuickReplySet.list.find(it => it.name == sel.value);
                await qrs.addQuickReplyRemote(qr.toJSON());
                if (!isCopy) {
                    qr.delete();
                }
            }
        };
    }

    removeQuickReply(qr) {
        this.qrList.splice(this.qrList.indexOf(qr), 1);
        this.saveQrDelete(qr.id);
    }

    toJSON() {
        return {
            version: 2,
            name: this.name,
            disableSend: this.disableSend,
            placeBeforeInput: this.placeBeforeInput,
            injectInput: this.injectInput,
            color: this.color,
            onlyBorderColor: this.onlyBorderColor,
            qrList: this.qrList,
            idIndex: this.idIndex,
        };
    }

    async performFullSave() {
        // Cancel any pending per-entry debounced edit (see _qrUpdateTimers) - this full save
        // supersedes it, and letting a stale debounced qrUpdates request land afterwards would
        // clobber part of what this full save just wrote.
        for (const timer of this._qrUpdateTimers.values()) clearTimeout(timer);
        this._qrUpdateTimers.clear();

        const response = await fetch('/api/quick-replies/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(this),
        });

        if (response.ok) {
            this.rerender();
        } else {
            warn(`Failed to save Quick Reply Set: ${this.name}`);
            console.error('QR could not be saved', response);
        }
    }

    async delete() {
        const response = await fetch('/api/quick-replies/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(this),
        });

        if (response.ok) {
            this.unrender();
            const idx = QuickReplySet.list.indexOf(this);
            if (idx > -1) {
                QuickReplySet.list.splice(idx, 1);
                this.isDeleted = true;
            } else {
                warn(`Deleted Quick Reply Set was not found in the list of sets: ${this.name}`);
            }
        } else {
            warn(`Failed to delete Quick Reply Set: ${this.name}`);
        }
    }
}
