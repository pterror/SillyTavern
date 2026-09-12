import { substituteParams } from '../../script.js';
import { power_user } from '../power-user.js';
import { delay, escapeRegex, uuidv4 } from '../utils.js';
import { SlashCommand } from './SlashCommand.js';
import { SlashCommandAbortController } from './SlashCommandAbortController.js';
import { SlashCommandBreak } from './SlashCommandBreak.js';
import { SlashCommandBreakController } from './SlashCommandBreakController.js';
import { SlashCommandBreakPoint } from './SlashCommandBreakPoint.js';
import { SlashCommandClosureResult } from './SlashCommandClosureResult.js';
import { SlashCommandDebugController } from './SlashCommandDebugController.js';
import { SlashCommandExecutionError } from './SlashCommandExecutionError.js';
import { SlashCommandExecutor } from './SlashCommandExecutor.js';
import { SlashCommandNamedArgumentAssignment } from './SlashCommandNamedArgumentAssignment.js';
import { SlashCommandScope } from './SlashCommandScope.js';

export class SlashCommandClosure {
    /** @type {SlashCommandScope} */ scope;
    /** @type {boolean} */ executeNow = false;
    /** @type {SlashCommandNamedArgumentAssignment[]} */ argumentList = [];
    /** @type {SlashCommandNamedArgumentAssignment[]} */ providedArgumentList = [];
    /** @type {SlashCommandExecutor[]} */ executorList = [];
    /** @type {SlashCommandAbortController} */ abortController;
    /** @type {SlashCommandBreakController} */ breakController;
    /** @type {SlashCommandDebugController} */ debugController;
    /** @type {(done:number, total:number)=>void} */ onProgress;
    /** @type {string} */ rawText;
    /** @type {string} */ fullText;
    /** @type {string} */ parserContext;
    /** @type {string} */ #source = uuidv4();
    get source() { return this.#source; }
    set source(value) {
        this.#source = value;
        for (const executor of this.executorList) {
            executor.source = value;
        }
    }

    /**@type {number}*/
    get commandCount() {
        return this.executorList.map(executor => executor.commandCount).reduce((sum, cur) => sum + cur, 0);
    }

    constructor(parent) {
        this.scope = new SlashCommandScope(parent);
    }

    toString() {
        return `[Closure]${this.executeNow ? '()' : ''}`;
    }

    /**
     * Performs parameter substitution using the macro engine.
     * @param {string} text Text to substitute
     * @param {SlashCommandScope} scope Script scope
     * @param {{key:string, value:string|SlashCommandClosure}[]} macroList Custom scope macros
     * @returns {string|SlashCommandClosure|(string|SlashCommandClosure)[]} Substituted text or list of strings/closures
     */
    substituteWithMacroEngine(text, scope, macroList) {
        /** @type {Record<string, import('./../macros/engine/MacroEnv.types.js').DynamicMacroValue>} */
        const dynamicMacros = {
            'pipe': () => scope.pipe,
            'var': {
                strictArgs: false,
                list: { min: 1, max: 2 },
                handler: (context) => {
                    try {
                        // unlike the legacy replacer, unknown variables must not halt execution
                        return scope.getVariable(context.list[0], context.list[1]);
                    } catch (error) {
                        console.warn('{{var}} dynamic macro execution error:', error);
                        return '';
                    }
                },
            },
        };

        const CLOSURE_BOUNDARY = '\uFFF0~CLOSURE~\uFFF0';
        /** @type {Map<string, SlashCommandClosure>} */
        const closures = new Map();
        /** @type {Record<string, { args: string[], value: string|SlashCommandClosure }[]>} */
        const customMacros = {};

        for (const macro of macroList) {
            const [name, ...rest] = macro.key.split('::');
            if (!Object.hasOwn(customMacros, name)) {
                customMacros[name] = [];
            }
            customMacros[name].push({ args: rest, value: macro.value });
        }

        for (const [macroName, macroArguments] of Object.entries(customMacros)) {
            dynamicMacros[macroName] = {
                strictArgs: false,
                list: { min: 0, max: Number.MAX_SAFE_INTEGER },
                handler: (context) => {
                    const sortedMacroArgs = macroArguments.toSorted((a, b) => {
                        const aHasWildcard = a.args.includes('*');
                        const bHasWildcard = b.args.includes('*');
                        if (aHasWildcard && !bHasWildcard) return 1;
                        if (!aHasWildcard && bHasWildcard) return -1;
                        return 0;
                    });

                    const findMacroMatch = (/** @type {{args: string[]}} */ i) => {
                        // Exact match
                        if (i.args.length === context.list.length && i.args.every((arg, index) => arg === context.list[index])) {
                            return true;
                        }
                        // Wildcard match - if any definition arg is '*', it matches any value at that position
                        if (i.args.length === context.list.length) {
                            return i.args.every((arg, index) => arg === '*' || arg === context.list[index]);
                        }
                        return false;
                    };

                    const replacer = sortedMacroArgs.find(findMacroMatch)?.value;
                    if (replacer instanceof SlashCommandClosure) {
                        replacer.abortController = this.abortController;
                        replacer.breakController = this.breakController;
                        replacer.scope.parent = this.scope;
                        if (this.debugController && !replacer.debugController) {
                            replacer.debugController = this.debugController;
                        }

                        const closureKey = uuidv4();
                        closures.set(closureKey, replacer);
                        return `${CLOSURE_BOUNDARY}${closureKey}${CLOSURE_BOUNDARY}`;
                    }

                    return String(replacer ?? '');
                },
            };
        }

        const substitutedText = substituteParams(text, { dynamicMacros });

        if (closures.size > 0) {
            const parts = substitutedText.split(CLOSURE_BOUNDARY).map(part => closures.has(part) ? closures.get(part) : part).filter(Boolean);
            return parts.length === 1 ? parts[0] : parts;
        }

        return substitutedText;
    }

    /**
     *
     * @param {string} text
     * @param {SlashCommandScope} scope
     * @returns {string|SlashCommandClosure|(string|SlashCommandClosure)[]}
     */
    substituteParams(text, scope = null) {
        let isList = false;
        let listValues = [];
        scope = scope ?? this.scope;
        const escapeMacro = (it, isAnchored = false) => {
            const regexText = escapeRegex(it.key.replace(/\*/g, '~~~WILDCARD~~~'))
                .replaceAll('~~~WILDCARD~~~', '(?:(?:(?!(?:::|}})).)*)')
            ;
            if (isAnchored) {
                return `^${regexText}$`;
            }
            return regexText;
        };
        const macroList = scope.macroList.toSorted((a, b) => {
            if (a.key.includes('*') && !b.key.includes('*')) return 1;
            if (!a.key.includes('*') && b.key.includes('*')) return -1;
            if (a.key.includes('*') && b.key.includes('*')) return b.key.indexOf('*') - a.key.indexOf('*');
            return 0;
        });
        if (power_user.experimental_macro_engine) {
            return this.substituteWithMacroEngine(text, scope, macroList);
        }
        const macros = macroList.map(it => escapeMacro(it)).join('|');
        const re = new RegExp(`(?<pipe>{{pipe}})|(?:{{var::(?<var>[^\\s]+?)(?:::(?<varIndex>(?!}}).+))?}})|(?:{{(?<macro>${macros})}})`);
        let done = '';
        let remaining = text;
        while (re.test(remaining)) {
            const match = re.exec(remaining);
            const before = substituteParams(remaining.slice(0, match.index));
            const after = remaining.slice(match.index + match[0].length);
            const replacer = match.groups.pipe ? scope.pipe : match.groups.var ? scope.getVariable(match.groups.var, match.groups.index) : macroList.find(it => it.key == match.groups.macro || new RegExp(escapeMacro(it, true)).test(match.groups.macro))?.value;
            if (replacer instanceof SlashCommandClosure) {
                replacer.abortController = this.abortController;
                replacer.breakController = this.breakController;
                replacer.scope.parent = this.scope;
                if (this.debugController && !replacer.debugController) {
                    replacer.debugController = this.debugController;
                }
                isList = true;
                if (match.index > 0) {
                    listValues.push(before);
                }
                listValues.push(replacer);
                if (match.index + match[0].length + 1 < remaining.length) {
                    const rest = this.substituteParams(after, scope);
                    listValues.push(...(Array.isArray(rest) ? rest : [rest]));
                }
                break;
            } else {
                done = `${done}${before}${replacer}`;
                remaining = after;
            }
        }
        if (!isList) {
            text = `${done}${substituteParams(remaining)}`;
        }

        if (isList) {
            if (listValues.length > 1) return listValues;
            return listValues[0];
        }
        return text;
    }

    getCopy() {
        const closure = new SlashCommandClosure();
        closure.scope = this.scope.getCopy();
        closure.executeNow = this.executeNow;
        closure.argumentList = this.argumentList;
        closure.providedArgumentList = this.providedArgumentList;
        closure.executorList = this.executorList;
        closure.abortController = this.abortController;
        closure.breakController = this.breakController;
        closure.debugController = this.debugController;
        closure.rawText = this.rawText;
        closure.fullText = this.fullText;
        closure.parserContext = this.parserContext;
        closure.source = this.source;
        closure.onProgress = this.onProgress;
        return closure;
    }

    /** @returns {Promise<SlashCommandClosureResult>} */
    async execute() {
        // Executes a copy, so a closure called twice (loop, multiple /run) isn't tainted by its own effects.
        const closure = this.getCopy();
        const gen = closure.executeDirect();
        let step;
        while (!step?.done) {
            step = await gen.next(this.debugController?.testStepping(this) ?? false);
            if (!(step.value instanceof SlashCommandClosureResult) && this.debugController) {
                this.debugController.isStepping = await this.debugController.awaitBreakPoint(step.value.closure, step.value.executor);
            }
        }
        return step.value;
    }

    async* executeDirect() {
        this.debugController?.down(this);
        for (const arg of this.argumentList) {
            let v = arg.value;
            if (v instanceof SlashCommandClosure) {
                /**@type {SlashCommandClosure}*/
                const closure = v;
                closure.scope.parent = this.scope;
                closure.breakController = this.breakController;
                if (closure.executeNow) {
                    v = (await closure.execute())?.pipe;
                } else {
                    v = closure;
                }
            } else {
                v = this.substituteParams(v);
            }
            // unescape value
            if (typeof v == 'string') {
                v = v
                    ?.replace(/\\\{/g, '{')
                    ?.replace(/\\\}/g, '}')
                ;
            }
            this.scope.letVariable(arg.name, v);
        }
        for (const arg of this.providedArgumentList) {
            let v = arg.value;
            if (v instanceof SlashCommandClosure) {
                /**@type {SlashCommandClosure}*/
                const closure = v;
                closure.scope.parent = this.scope;
                closure.breakController = this.breakController;
                if (closure.executeNow) {
                    v = (await closure.execute())?.pipe;
                } else {
                    v = closure;
                }
            } else {
                v = this.substituteParams(v, this.scope.parent);
            }
            // unescape value
            if (typeof v == 'string') {
                v = v
                    ?.replace(/\\\{/g, '{')
                    ?.replace(/\\\}/g, '}')
                ;
            }
            this.scope.setVariable(arg.name, v);
        }

        if (this.executorList.length == 0) {
            this.scope.pipe = '';
        }
        const stepper = this.executeStep();
        let step;
        while (!step?.done && !this.breakController?.isBreak) {
            step = await stepper.next();
            if (step.value instanceof SlashCommandBreakPoint) {
                if (this.debugController) {
                    step = await stepper.next();
                    step = await stepper.next();
                    step = await stepper.next();
                    // Must yield before arguments resolve if one is an immediate closure, or stepping into it is impossible.
                    const hasImmediateClosureInNamedArgs = /**@type {SlashCommandExecutor}*/(step.value)?.namedArgumentList?.find(it => it.value instanceof SlashCommandClosure && it.value.executeNow);
                    const hasImmediateClosureInUnnamedArgs = /**@type {SlashCommandExecutor}*/(step.value)?.unnamedArgumentList?.find(it => it.value instanceof SlashCommandClosure && it.value.executeNow);
                    if (hasImmediateClosureInNamedArgs || hasImmediateClosureInUnnamedArgs) {
                        this.debugController.isStepping = yield { closure: this, executor: step.value };
                    } else {
                        this.debugController.isStepping = true;
                        this.debugController.stepStack[this.debugController.stepStack.length - 1] = true;
                    }
                }
            } else if (!step.done && this.debugController?.testStepping(this)) {
                this.debugController.isSteppingInto = false;
                // Must yield before arguments resolve if one is an immediate closure, or stepping into it is impossible.
                const hasImmediateClosureInNamedArgs = /**@type {SlashCommandExecutor}*/(step.value)?.namedArgumentList?.find(it => it.value instanceof SlashCommandClosure && it.value.executeNow);
                const hasImmediateClosureInUnnamedArgs = /**@type {SlashCommandExecutor}*/(step.value)?.unnamedArgumentList?.find(it => it.value instanceof SlashCommandClosure && it.value.executeNow);
                if (hasImmediateClosureInNamedArgs || hasImmediateClosureInUnnamedArgs) {
                    this.debugController.isStepping = yield { closure: this, executor: step.value };
                }
            }
            step = await stepper.next();
            if (step.value instanceof SlashCommandBreak) {
                if (this.breakController) {
                    this.breakController?.break();
                    break;
                }
            } else if (!step.done && this.debugController?.testStepping(this)) {
                this.debugController.isSteppingInto = false;
                this.debugController.isStepping = yield { closure: this, executor: step.value };
            }
            step = await stepper.next();
        }

        // execution can return a closure result directly, which should only happen on abort
        if (step.value instanceof SlashCommandClosureResult) {
            this.debugController?.up();
            return step.value;
        }
        /**@type {SlashCommandClosureResult} */
        const result = Object.assign(new SlashCommandClosureResult(), { pipe: this.scope.pipe, isBreak: this.breakController?.isBreak ?? false });
        this.debugController?.up();
        return result;
    }
    // Steps through the executor list; each executor yields three times: before/after argument
    // resolution, and after execution.
    async* executeStep() {
        let done = 0;
        let isFirst = true;
        for (const executor of this.executorList) {
            this.onProgress?.(done, this.commandCount);
            if (this.debugController) {
                this.debugController.setExecutor(executor);
                this.debugController.namedArguments = undefined;
                this.debugController.unnamedArguments = undefined;
            }
            // The debugger might want to act on this executor before anything happens to it.
            yield executor;
            /**@type {import('./SlashCommand.js').NamedArguments} */
            // @ts-ignore
            let args = {
                _scope: this.scope,
                _parserFlags: executor.parserFlags,
                _abortController: this.abortController,
                _debugController: this.debugController,
                _hasUnnamedArgument: executor.unnamedArgumentList.length > 0,
            };
            if (executor instanceof SlashCommandBreakPoint) {
                // nothing to do for breakpoints, just raise counter and yield for "before exec"
                done++;
                yield executor;
                isFirst = false;
            } else if (executor instanceof SlashCommandBreak) {
                // /break need to resolve the unnamed arg and put it into pipe, then yield
                // for "before exec"
                const value = await this.substituteUnnamedArgument(executor, isFirst, args);
                done += this.executorList.length - this.executorList.indexOf(executor);
                this.scope.pipe = value ?? this.scope.pipe;
                yield executor;
                isFirst = false;
            } else {
                // regular commands do all the argument resolving logic...
                await this.substituteNamedArguments(executor, args);
                let value = await this.substituteUnnamedArgument(executor, isFirst, args);

                let abortResult = await this.testAbortController();
                if (abortResult) {
                    return abortResult;
                }
                if (this.debugController) {
                    this.debugController.namedArguments = args;
                    this.debugController.unnamedArguments = value ?? '';
                }
                // then yield for "before exec"
                yield executor;
                // followed by command execution
                executor.onProgress = (subDone, subTotal) => this.onProgress?.(done + subDone, this.commandCount);
                const isStepping = this.debugController?.testStepping(this);
                if (this.debugController) {
                    this.debugController.isStepping = false || this.debugController.isSteppingInto;
                }
                try {
                    this.scope.pipe = await executor.command.callback(args, value ?? '');
                } catch (ex) {
                    throw new SlashCommandExecutionError(ex, ex.message, executor.name, executor.start, executor.end, this.fullText.slice(executor.start, executor.end), this.fullText);
                }
                if (this.debugController) {
                    this.debugController.namedArguments = undefined;
                    this.debugController.unnamedArguments = undefined;
                    this.debugController.isStepping = isStepping;
                }
                this.#lintPipe(executor.command);
                done += executor.commandCount;
                this.onProgress?.(done, this.commandCount);
                abortResult = await this.testAbortController();
                if (abortResult) {
                    return abortResult;
                }
            }
            // finally, yield for "after exec"
            yield executor;
            isFirst = false;
        }
    }

    async testPaused() {
        while (!this.abortController?.signal?.aborted && this.abortController?.signal?.paused) {
            await delay(200);
        }
    }
    async testAbortController() {
        await this.testPaused();
        if (this.abortController?.signal?.aborted) {
            const result = new SlashCommandClosureResult();
            result.isAborted = true;
            result.isQuietlyAborted = this.abortController.signal.isQuiet;
            result.abortReason = this.abortController.signal.reason.toString();
            return result;
        }
    }

    /**
     * @param {SlashCommandExecutor} executor
     * @param {import('./SlashCommand.js').NamedArguments} args
     */
    async substituteNamedArguments(executor, args) {
        const assign = (name, value) => {
            if (Array.isArray(value)) {
                for (const val of value) {
                    assign(name, val);
                }
                return;
            }

            const definition = executor.command.namedArgumentList.find(x => x.name == name);
            name = definition?.name ?? name;

            if (value && typeof value == 'string') {
                value = value
                    .replace(/\\\{/g, '{')
                    .replace(/\\\}/g, '}');
            }

            if (definition?.acceptsMultiple) {
                if (args[name] !== undefined) {
                    let currentValue = args[name];
                    if (!Array.isArray(currentValue)) {
                        currentValue = [currentValue];
                    }
                    currentValue.push(value);
                    args[name] = currentValue;
                } else {
                    args[name] = [value];
                }
            } else {
                args[name] !== undefined && console.debug(`Named argument assigned multiple times: ${name}`);
                args[name] = value;
            }
        };

        for (const arg of executor.namedArgumentList) {
            if (arg.value instanceof SlashCommandClosure) {
                /**@type {SlashCommandClosure}*/
                const closure = arg.value;
                closure.scope.parent = this.scope;
                closure.breakController = this.breakController;
                if (this.debugController && !closure.debugController) {
                    closure.debugController = this.debugController;
                }
                if (closure.executeNow) {
                    assign(arg.name, (await closure.execute())?.pipe);
                } else {
                    assign(arg.name, closure);
                }
            } else {
                assign(arg.name, this.substituteParams(arg.value));
            }
        }
    }

    /**
     * @param {SlashCommandExecutor} executor
     * @param {boolean} isFirst
     * @param {import('./SlashCommand.js').NamedArguments} args
     * @returns {Promise<string|SlashCommandClosure|(string|SlashCommandClosure)[]>}
     */
    async substituteUnnamedArgument(executor, isFirst, args) {
        let value;
        if (executor.unnamedArgumentList.length == 0) {
            if (!isFirst && executor.injectPipe) {
                value = this.scope.pipe;
                args._hasUnnamedArgument = this.scope.pipe !== null && this.scope.pipe !== undefined;
            }
        } else {
            value = [];
            for (let i = 0; i < executor.unnamedArgumentList.length; i++) {
                /** @type {string|SlashCommandClosure|(string|SlashCommandClosure)[]} */
                let v = executor.unnamedArgumentList[i].value;
                if (v instanceof SlashCommandClosure) {
                    /**@type {SlashCommandClosure}*/
                    const closure = v;
                    closure.scope.parent = this.scope;
                    closure.breakController = this.breakController;
                    if (this.debugController && !closure.debugController) {
                        closure.debugController = this.debugController;
                    }
                    if (closure.executeNow) {
                        v = (await closure.execute())?.pipe;
                    } else {
                        v = closure;
                    }
                } else {
                    v = this.substituteParams(v);
                }
                value[i] = v;
            }
            if (!executor.command.splitUnnamedArgument) {
                if (value.length == 1) {
                    value = value[0];
                } else if (!value.find(it => it instanceof SlashCommandClosure)) {
                    value = value.join('');
                }
            }
        }
        if (typeof value == 'string') {
            value = value
                ?.replace(/\\\{/g, '{')
                ?.replace(/\\\}/g, '}')
            ;
        } else if (Array.isArray(value)) {
            value = value.map(v => {
                if (typeof v == 'string') {
                    return v
                        ?.replace(/\\\{/g, '{')
                        ?.replace(/\\\}/g, '}');
                }
                return v;
            });
        }

        value ??= '';

        if (executor.command.splitUnnamedArgument && !Array.isArray(value)) {
            value = [value];
        }

        return value;
    }

    /**
     * Auto-fixes the pipe if it is not a valid result for STscript.
     * @param {SlashCommand} command Command being executed
     */
    #lintPipe(command) {
        if (this.scope.pipe === undefined || this.scope.pipe === null) {
            console.warn(`/${command.name} returned undefined or null. Auto-fixing to empty string.`);
            this.scope.pipe = '';
        } else if (!(typeof this.scope.pipe == 'string' || this.scope.pipe instanceof SlashCommandClosure)) {
            console.warn(`/${command.name} returned illegal type (${typeof this.scope.pipe} - ${this.scope.pipe.constructor?.name ?? ''}). Auto-fixing to stringified JSON.`);
            this.scope.pipe = JSON.stringify(this.scope.pipe) ?? '';
        }
    }
}
