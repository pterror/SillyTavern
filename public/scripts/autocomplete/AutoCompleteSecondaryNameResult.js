import { AutoCompleteNameResultBase } from './AutoCompleteNameResultBase.js';

export class AutoCompleteSecondaryNameResult extends AutoCompleteNameResultBase {
    /**@type {boolean}*/ isRequired = false;
    /**@type {boolean}*/ forceMatch = true;
    /** @type {((typed: string) => Promise<import('./AutoCompleteOption.js').AutoCompleteOption[]>)?} */
    loadOptions = null;
}
