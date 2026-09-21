import { SlashCommandParser } from '../SlashCommandParser.js';
import { SlashCommand } from '../SlashCommand.js';
import { t } from '../../i18n.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../SlashCommandArgument.js';
import { SlashCommandClosure } from '../SlashCommandClosure.js';
import { commonEnumProviders } from '../SlashCommandCommonEnumsProvider.js';
import { SlashCommandExecutionError } from '../SlashCommandExecutionError.js';
import { copyText, isFalseBoolean, regexFromString } from '../../utils.js';

export function registerTextUtilsCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'upper',
        aliases: ['uppercase', 'to-upper'],
        callback: (_, text) => typeof text === 'string' ? text.toUpperCase() : '',
        returns: t`uppercase string`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to affect`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: t`Converts the provided string to uppercase.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lower',
        aliases: ['lowercase', 'to-lower'],
        callback: (_, text) => typeof text === 'string' ? text.toLowerCase() : '',
        returns: t`lowercase string`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to affect`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: t`Converts the provided string to lowercase.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'substr',
        aliases: ['substring'],
        callback: (arg, text) => typeof text === 'string' ? text.slice(...[Number(arg.start), arg.end && Number(arg.end)]) : '',
        returns: t`substring`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'start', t`start index`, [ARGUMENT_TYPE.NUMBER], false, false,
            ),
            new SlashCommandNamedArgument(
                'end', t`end index`, [ARGUMENT_TYPE.NUMBER], false, false,
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to affect`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: `
            <div>
                ${t`Extracts text from the provided string.`}
            </div>
            <div>
                ${t`If <code>start</code> is omitted, it's treated as 0.<br />`}
                ${t`If <code>start</code> < 0, the index is counted from the end of the string.<br />`}
                ${t`If <code>start</code> >= the string's length, an empty string is returned.<br />`}
                ${t`If <code>end</code> is omitted, or if <code>end</code> >= the string's length, extracts to the end of the string.<br />`}
                ${t`If <code>end</code> < 0, the index is counted from the end of the string.<br />`}
                ${t`If <code>end</code> <= <code>start</code> after normalizing negative values, an empty string is returned.`}
            </div>
            <div>
                <strong>${t`Example:`}</strong>
                <pre>/let x The morning is upon us.     ||                                     </pre>
                <pre>/substr start=-3 {{var::x}}         | /echo  |/# us.                    ||</pre>
                <pre>/substr start=-3 end=-1 {{var::x}}  | /echo  |/# us                     ||</pre>
                <pre>/substr end=-1 {{var::x}}           | /echo  |/# The morning is upon us ||</pre>
                <pre>/substr start=4 end=-1 {{var::x}}   | /echo  |/# morning is upon us     ||</pre>
            </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'replace',
        aliases: ['re'],
        callback: (async ({ mode = 'literal', pattern, replacer = '' }, text) => {
            if (!pattern) {
                throw new Error(t`Argument of 'pattern=' cannot be empty`);
            }
            text = text.toString();
            pattern = pattern.toString();
            replacer = replacer.toString();
            switch (mode) {
                case 'literal':
                    return text.replaceAll(pattern, replacer);
                case 'regex':
                    return text.replace(regexFromString(pattern), replacer);
                default:
                    throw new Error(t`Invalid '/replace mode=' argument specified!`);
            }
        }),
        returns: t`replaced text`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: t`Replaces occurrence(s) of a pattern`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'literal',
                enumList: ['literal', 'regex'],
            }),
            new SlashCommandNamedArgument(
                'pattern', t`pattern to search with`, [ARGUMENT_TYPE.STRING], true, false,
            ),
            new SlashCommandNamedArgument(
                'replacer', t`replacement text for matches`, [ARGUMENT_TYPE.STRING], false, false, '',
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to affect`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: `
            <div>
                ${t`Replaces text within the provided string based on the pattern.`}
            </div>
            <div>
                ${t`If <code>mode</code> is <code>literal</code> (or omitted), <code>pattern</code> is a literal search string (case-sensitive).<br />`}
                ${t`If <code>mode</code> is <code>regex</code>, <code>pattern</code> is parsed as an ECMAScript Regular Expression.<br />`}
                ${t`The <code>replacer</code> replaces based on the <code>pattern</code> in the input text.<br />`}
                ${t`If <code>replacer</code> is omitted, the replacement(s) will be an empty string.<br />`}
            </div>
            <div>
                <strong>${t`Example:`}</strong>
                <pre><code class="language-stscript">/let x Blue house and blue car ||                                                                        </code></pre>
                <pre><code class="language-stscript">/replace pattern="blue" {{var::x}}                                | /echo  |/# Blue house and  car     ||</code></pre>
                <pre><code class="language-stscript">/replace pattern="blue" replacer="red" {{var::x}}                 | /echo  |/# Blue house and red car  ||</code></pre>
                <pre><code class="language-stscript">/replace mode=regex pattern="/blue/i" replacer="red" {{var::x}}   | /echo  |/# red house and blue car  ||</code></pre>
                <pre><code class="language-stscript">/replace mode=regex pattern="/blue/gi" replacer="red" {{var::x}}  | /echo  |/# red house and red car   ||</code></pre>
            </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'test',
        callback: (({ pattern }, text) => {
            if (!pattern) {
                throw new Error(t`Argument of 'pattern=' cannot be empty`);
            }
            const re = regexFromString(pattern.toString());
            if (!re) {
                throw new Error(t`The value of 'pattern' argument is not a valid regular expression.`);
            }
            return JSON.stringify(re.test(text.toString()));
        }),
        returns: 'true | false',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'pattern', t`pattern to find`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to test`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: `
            <div>
                ${t`Tests text for a regular expression match.`}
            </div>
            <div>
                ${t`Returns <code>true</code> if the match is found, <code>false</code> otherwise.`}
            </div>
            <div>
                <strong>${t`Example:`}</strong>
                <pre><code class="language-stscript">/let x Blue house and green car                         ||</code></pre>
                <pre><code class="language-stscript">/test pattern="green" {{var::x}}    | /echo  |/# true   ||</code></pre>
                <pre><code class="language-stscript">/test pattern="blue" {{var::x}}     | /echo  |/# false  ||</code></pre>
                <pre><code class="language-stscript">/test pattern="/blue/i" {{var::x}}  | /echo  |/# true   ||</code></pre>
            </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'match',
        callback: (({ pattern }, text) => {
            if (!pattern) {
                throw new Error(t`Argument of 'pattern=' cannot be empty`);
            }
            const re = regexFromString(pattern.toString());
            if (!re) {
                throw new Error(t`The value of 'pattern' argument is not a valid regular expression.`);
            }
            if (re.flags.includes('g')) {
                return JSON.stringify([...text.toString().matchAll(re)]);
            } else {
                const match = text.toString().match(re);
                return match ? JSON.stringify(match) : '';
            }
        }),
        returns: t`group array for each match`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'pattern', t`pattern to find`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to match against`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: `
            <div>
                ${t`Retrieves regular expression matches in the given text`}
            </div>
            <div>
                ${t`Returns an array of groups (with the first group being the full match). If the regex contains the global flag (i.e. <code>/g</code>), multiple nested arrays are returned for each match. If the regex is global, returns <code>[]</code> if no matches are found, otherwise it returns an empty string.`}
            </div>
            <div>
                <strong>${t`Example:`}</strong>
                <pre><code class="language-stscript">/let x color_green green lamp color_blue                                                                            ||</code></pre>
                <pre><code class="language-stscript">/match pattern="green" {{var::x}}            | /echo  |/# [ "green" ]                                               ||</code></pre>
                <pre><code class="language-stscript">/match pattern="color_(\\w+)" {{var::x}}      | /echo  |/# [ "color_green", "green" ]                                ||</code></pre>
                <pre><code class="language-stscript">/match pattern="/color_(\\w+)/g" {{var::x}}   | /echo  |/# [ [ "color_green", "green" ], [ "color_blue", "blue" ] ]  ||</code></pre>
                <pre><code class="language-stscript">/match pattern="orange" {{var::x}}           | /echo  |/#                                                           ||</code></pre>
                <pre><code class="language-stscript">/match pattern="/orange/g" {{var::x}}        | /echo  |/# []                                                        ||</code></pre>
            </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'clipboard-get',
        returns: t`clipboard text`,
        callback: async () => {
            if (!navigator.clipboard) {
                toastr.warning(t`Clipboard API not available in this context.`);
                return '';
            }

            try {
                const text = await navigator.clipboard.readText();
                return text;
            } catch (error) {
                console.error('Error reading clipboard:', error);
                toastr.warning(t`Failed to read clipboard text. Have you granted the permission?`);
                return '';
            }
        },
        helpString: t`Retrieves the text from the OS clipboard. Only works in secure contexts (HTTPS or localhost). Browser may ask for permission.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'clipboard-set',
        callback: async (_, text) => {
            await copyText(text.toString());
            return '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`text to copy to the clipboard`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                acceptsMultiple: false,
            }),
        ],
        helpString: t`Copies the provided text to the OS clipboard. Returns an empty string.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'array-wrap',
        aliases: ['list-wrap'],
        returns: t`unnamed argument value wrapped into an array`,
        helpString: t`Wraps a single unnamed argument into an array if it's not already an array. If the value is an empty string, returns an empty array.`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'stringify',
                description: t`Whether JSON primitives (numbers, booleans, nulls) should be treated as strings, i.e. ["null"] when stringify=true vs. [null] when stringify=false.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`value`,
                acceptsMultiple: false,
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.DICTIONARY, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.LIST],
            }),
        ],
        callback: (args, value) => {
            if (value instanceof SlashCommandClosure) {
                throw new SlashCommandExecutionError(t`Closures are not supported as unnamed arguments for /array-wrap. Did you forget to call the closure with parentheses?`);
            }

            if (Array.isArray(value)) {
                throw new SlashCommandExecutionError(t`/array-wrap does not support multiple unnamed arguments.`);
            }

            if (value === '') {
                return JSON.stringify([]);
            }

            try {
                const parsedValue = JSON.parse(value);

                if (Array.isArray(parsedValue)) {
                    return value;
                }

                if (typeof parsedValue === 'object' && parsedValue !== null) {
                    return JSON.stringify([parsedValue]);
                }

                const isJsonPrimitive = parsedValue === null || ['string', 'number', 'boolean'].includes(typeof parsedValue);
                if (isJsonPrimitive && isFalseBoolean(String(args?.stringify?.toString()))) {
                    return JSON.stringify([parsedValue]);
                }

                // Wrap the original value (string, number, boolean) into an array, preserving quotes for strings
                return JSON.stringify([value]);
            } catch {
                return JSON.stringify([value]);
            }
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'array-unwrap',
        aliases: ['list-unwrap'],
        returns: t`unnamed argument value unwrapped from an array`,
        helpString: t`Unwraps the first element of an array provided as an unnamed argument. If the value is not an array, returns the value as-is. If the array is empty, returns an empty string.`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`value`,
                acceptsMultiple: false,
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.DICTIONARY, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.LIST],
            }),
        ],
        callback: (_args, value) => {
            if (value instanceof SlashCommandClosure) {
                throw new SlashCommandExecutionError(t`Closures are not supported as unnamed arguments for /array-unwrap. Did you forget to call the closure with parentheses?`);
            }

            if (Array.isArray(value)) {
                throw new SlashCommandExecutionError(t`/array-unwrap does not support multiple unnamed arguments.`);
            }

            try {
                const parsed = JSON.parse(value);

                if (Array.isArray(parsed)) {
                    const unwrappedValue = parsed?.[0] ?? '';

                    if (unwrappedValue === null || unwrappedValue === undefined) {
                        return '';
                    }

                    if (typeof unwrappedValue === 'object') {
                        return JSON.stringify(unwrappedValue);
                    }

                    return String(unwrappedValue);
                }
                return value;
            } catch {
                return value;
            }
        },
    }));
}
