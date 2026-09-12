import { AutoCompleteOption } from './AutoCompleteOption.js';


export class AutoCompleteNameResultBase {
    /**@type {string} */ name;
    /**@type {number} */ start;
    /**@type {AutoCompleteOption[]} */ optionList = [];
    /**@type {boolean} */ canBeQuoted = false;
    /**@type {()=>string} */ makeNoMatchText = () => `No matches found for "${this.name}"`;
    /**@type {()=>string} */ makeNoOptionsText = () => 'No options';


    constructor(name, start, optionList = [], canBeQuoted = false, makeNoMatchText = null, makeNoOptionsText = null) {
        this.name = name;
        this.start = start;
        this.optionList = optionList;
        this.canBeQuoted = canBeQuoted;
        if (makeNoMatchText) this.makeNoMatchText = makeNoMatchText;
        if (makeNoOptionsText) this.makeNoOptionsText = makeNoOptionsText;
    }
}
