import { substituteParams } from '../../../../script.js';
import { getRequestHeaders } from '../../../request-headers.js';
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

    /** @type {Map<number, ReturnType<typeof setTimeout>>} */
    _qrUpdateTimers = new Map();

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

    saveSetProp(prop, value) {
        return this._dispatchSave({ setProps: { [prop]: value } });
    }

    /**
     * @param {QuickReply} qr
     * @param {boolean} [immediate]
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

    saveQrAdd(qr) {
        return this._dispatchSave({ qrAdds: [qr], setProps: { idIndex: this.idIndex } });
    }

    saveQrDelete(id) {
        clearTimeout(this._qrUpdateTimers.get(id));
        this._qrUpdateTimers.delete(id);
        return this._dispatchSave({ qrDeletes: [id] });
    }

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
     * @param {object} [data]
     * @param {object} [options]
     * @param {boolean} [options.dispatch]
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
