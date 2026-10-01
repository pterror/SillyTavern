import { AutoCompleteNameResultBase } from './AutoCompleteNameResultBase.js';

export class AutoCompleteSecondaryNameResult extends AutoCompleteNameResultBase {
    /**@type {boolean}*/ isRequired = false;
    /**@type {boolean}*/ forceMatch = true;
    /**
     * Options that have to be asked for with the typed text, added to `optionList` once they arrive.
     * @type {((typed: string) => Promise<import('./AutoCompleteOption.js').AutoCompleteOption[]>)?}
     */
    loadOptions = null;
}
