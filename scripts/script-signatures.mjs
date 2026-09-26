// Signatures of public/script.js's exports, for scripts/script-exports.mjs.
//
// An upstream export's signature is recorded in `.upstream-script-signatures`, one line per export:
//
//   <name> <kind> <param> <param> ...
//
// <kind> is `value` (not callable), `opaque` (its kind isn't read; only the name is checked), `fn`
// (sync callable) or `async` (async callable). Params follow `fn`/`async` only:
//   name / name?            a plain param, `?` when optional
//   ...name                 a rest param
//   jsdoc{prop,prop?}       a destructured object; `jsdoc` is its JSDoc @param name, `_` without one;
//                           `?` after `}` when the param itself is optional
//   [] / []?                a destructured array
// A param is optional when it has a default, is a rest param, or its JSDoc is `@param [x]`; a
// property when it has a default or its JSDoc is `@param [x.prop]`.
//
// Names are resolved through `import` bindings to the declaring module. Variable initializers:
//   arrow / function expression      fn or async, with its params
//   literal, object or array literal value
//   known wrapper call (table below) fn or async by what the wrapper returns, with the params of
//                                    its first argument (an arrow, function expression, or a
//                                    function declaration it resolves to); opaque otherwise
//   f.bind(thisArg, a1..an)          f's kind and params minus the first n; `obj.m` where obj is
//                                    `new C(...)` resolves to class C's method m; opaque if f
//                                    can't be resolved
//   = otherName                      otherName's signature, followed through chains; opaque on a
//                                    cycle or when it has no declaration
//   other call, new, property read,  opaque
//   no initializer, class, generator
//   let/var bound to a function      opaque, since it can be reassigned
// Anything else fails as unhandled.
//
// When unsure about upstream's side, it is opaque (presence only). When upstream's side is a
// function, ours must be a callable with compatible params.
//
// A computed key in ours' destructured param is an extra optional property that carries no
// upstream property name, so it is left out of ours' signature; it must have a default. A computed
// key without a default, or one on upstream's side, fails as unhandled.

import path from 'node:path';

export const SIGNATURES_FILE = '.upstream-script-signatures';

/** Function-wrapping helpers: each forwards its arguments to its first argument. */
const WRAPPERS = new Map([
    ['public/scripts/utils.js#debounce', 'fn'],
    ['public/scripts/utils.js#debounceAsync', 'async'],
    ['public/scripts/utils.js#throttle', 'fn'],
    ['public/scripts/utils.js#debouncedThrottle', 'fn'],
    ['public/scripts/PromptManager.js#debouncePromise', 'async'],
]);

const NAME_PATTERN = /^[A-Za-z_$][\w$]*$/;

export class SignatureError extends Error {}

/**
 * Computes signatures of `names` exported by public/script.js in one tree.
 * @param {any} ts The typescript module.
 * @param {(relPath: string) => string} read Returns a repo-relative file's text; throws SignatureError.
 * @param {string} label Describes the tree in messages.
 * @param {{ ours?: boolean }} [options] `ours` for our tree, whose computed destructured keys are extras.
 */
export function createAnalyzer(ts, read, label, { ours = false } = {}) {
    const modules = new Map();

    function loadModule(rel) {
        if (modules.has(rel)) return modules.get(rel);
        const text = read(rel);
        const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        if (!Array.isArray(sf.parseDiagnostics)) {
            throw new SignatureError(`could not confirm that ${label}:${rel} parsed: this TypeScript build exposes no parse diagnostics.`);
        }
        if (sf.parseDiagnostics.length > 0) {
            const d = sf.parseDiagnostics[0];
            const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
            throw new SignatureError(`could not parse ${label}:${rel}:${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
        }
        const mod = { rel, sf, decls: new Map(), imports: new Map(), exports: new Map(), star: false };
        const exported = (node) => (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
        for (const statement of sf.statements) {
            if (ts.isImportDeclaration(statement)) {
                const from = resolveSpecifier(rel, statement.moduleSpecifier.text);
                const clause = statement.importClause;
                if (!clause) continue;
                if (clause.name) mod.imports.set(clause.name.text, { from, imported: 'default' });
                const bindings = clause.namedBindings;
                if (bindings && ts.isNamespaceImport(bindings)) mod.imports.set(bindings.name.text, { from, imported: '*' });
                if (bindings && ts.isNamedImports(bindings)) {
                    for (const element of bindings.elements) {
                        mod.imports.set(element.name.text, { from, imported: (element.propertyName ?? element.name).text });
                    }
                }
            } else if (ts.isExportDeclaration(statement)) {
                const from = statement.moduleSpecifier ? resolveSpecifier(rel, statement.moduleSpecifier.text) : undefined;
                if (!statement.exportClause) {
                    mod.star = true;
                } else if (ts.isNamedExports(statement.exportClause)) {
                    for (const element of statement.exportClause.elements) {
                        const local = (element.propertyName ?? element.name).text;
                        mod.exports.set(element.name.text, from === undefined ? { local } : { from, imported: local });
                    }
                }
            } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
                mod.decls.set(statement.name.text, statement);
                if (exported(statement)) mod.exports.set(statement.name.text, { local: statement.name.text });
            } else if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    for (const name of bindingNames(declaration.name)) {
                        mod.decls.set(name, declaration);
                        if (exported(statement)) mod.exports.set(name, { local: name });
                    }
                }
            }
        }
        modules.set(rel, mod);
        return mod;
    }

    function bindingNames(name) {
        if (ts.isIdentifier(name)) return [name.text];
        return name.elements.flatMap(element => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
    }

    /** Resolves `name` exported by module `rel` to `{ mod, node }`, or null when it can't be. */
    function resolveExport(rel, name, seen) {
        if (rel === null) return null;
        const key = `${rel}#export#${name}`;
        if (seen.has(key)) return null;
        seen.add(key);
        const mod = loadModule(rel);
        const entry = mod.exports.get(name);
        if (!entry) return null;
        if (entry.from !== undefined) return entry.imported === 'default' ? null : resolveExport(entry.from, entry.imported, seen);
        return resolveLocal(mod, entry.local, seen);
    }

    /** Resolves a name in module scope to its declaration, through imports. */
    function resolveLocal(mod, name, seen) {
        const key = `${mod.rel}#local#${name}`;
        if (seen.has(key)) return null;
        seen.add(key);
        const node = mod.decls.get(name);
        if (node) return { mod, node };
        const imported = mod.imports.get(name);
        if (!imported || imported.imported === '*' || imported.imported === 'default') return null;
        return resolveExport(imported.from, imported.imported, seen);
    }

    const OPAQUE = Object.freeze({ kind: 'opaque' });
    const VALUE = Object.freeze({ kind: 'value' });

    function where(mod, node) {
        return `${label}:${mod.rel}:${mod.sf.getLineAndCharacterOfPosition(node.getStart(mod.sf)).line + 1}`;
    }

    function unhandled(mod, node, exportName, what) {
        throw new SignatureError(`${where(mod, node)}: ${exportName}: ${what} (${ts.SyntaxKind[node.kind]}) is not a form the signature check handles.`);
    }

    function isAsync(node) {
        return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
    }

    function functionSignature(mod, fn, exportName, drop = 0) {
        if (fn.asteriskToken) return OPAQUE;
        const params = fn.parameters.map(param => paramSignature(mod, fn, param, exportName));
        return { kind: isAsync(fn) ? 'async' : 'fn', params: dropLeading(params, drop) };
    }

    function dropLeading(params, count) {
        const out = [...params];
        for (let i = 0; i < count && out.length > 0 && out[0].type !== 'rest'; i++) out.shift();
        return out;
    }

    function checkedName(mod, node, exportName, name) {
        if (!NAME_PATTERN.test(name)) unhandled(mod, node, exportName, `the name ${JSON.stringify(name)}`);
        return name;
    }

    function paramSignature(mod, fn, param, exportName) {
        const tags = ts.getJSDocParameterTags(param);
        const bracketed = tags.some(tag => tag.isBracketed);
        if (ts.isIdentifier(param.name)) {
            const name = checkedName(mod, param, exportName, param.name.text);
            if (param.dotDotDotToken) return { type: 'rest', name };
            return { type: 'plain', name, optional: Boolean(param.initializer || param.questionToken || bracketed) };
        }
        if (param.dotDotDotToken) unhandled(mod, param, exportName, 'a destructured rest param');
        const optional = Boolean(param.initializer || param.questionToken || bracketed);
        if (ts.isArrayBindingPattern(param.name)) return { type: 'array', name: '[]', optional };
        const jsdoc = tags.length > 0 ? checkedName(mod, param, exportName, tags[0].name.getText(mod.sf)) : '_';
        // TypeScript nests `@param [x.prop]` under `@param {object} x` when the root has an object type.
        const rootType = tags[0]?.typeExpression;
        const literal = rootType && (ts.isJSDocTypeLiteral(rootType) ? rootType : rootType.type && ts.isJSDocTypeLiteral(rootType.type) ? rootType.type : undefined);
        const nested = literal?.jsDocPropertyTags ?? [];
        const subTags = jsdoc === '_' ? [] : [...ts.getJSDocTags(fn).filter(ts.isJSDocParameterTag), ...nested];
        const props = param.name.elements.flatMap(element => {
            if (element.dotDotDotToken) unhandled(mod, element, exportName, 'a rest element in a destructured param');
            const key = element.propertyName ?? element.name;
            if (ours && ts.isComputedPropertyName(key) && element.initializer) return [];
            if (!(ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key))) {
                unhandled(mod, element, exportName, 'a computed property in a destructured param');
            }
            const name = checkedName(mod, element, exportName, key.text);
            const propBracketed = subTags.some(tag => tag.isBracketed && tag.name.getText(mod.sf) === `${jsdoc}.${name}`);
            return [{ name, optional: Boolean(element.initializer || propBracketed) }];
        }).sort((a, b) => compareNames(a.name, b.name));
        return { type: 'object', name: jsdoc, optional, props };
    }

    function stripParens(node) {
        while (ts.isParenthesizedExpression(node)) node = node.expression;
        return node;
    }

    function isValueLiteral(node) {
        return ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)
            || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isRegularExpressionLiteral(node)
            || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
            || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword
            || (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) && ts.isNumericLiteral(node.operand));
    }

    /** The signature of a resolved declaration. */
    function declarationSignature(resolved, exportName, seen) {
        if (!resolved) return OPAQUE;
        const { mod, node } = resolved;
        if (ts.isFunctionDeclaration(node)) return functionSignature(mod, node, exportName);
        if (ts.isClassDeclaration(node)) return OPAQUE;
        if (!ts.isVariableDeclaration(node)) unhandled(mod, node, exportName, 'a declaration');
        if (!ts.isIdentifier(node.name) || !node.initializer) return OPAQUE;
        const reassignable = !(node.parent.flags & ts.NodeFlags.Const);
        return initializerSignature(mod, stripParens(node.initializer), exportName, seen, reassignable);
    }

    function initializerSignature(mod, init, exportName, seen, reassignable) {
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            return reassignable ? OPAQUE : functionSignature(mod, init, exportName);
        }
        if (isValueLiteral(init)) return VALUE;
        if (ts.isIdentifier(init)) {
            const signature = declarationSignature(resolveLocal(mod, init.text, seen), exportName, seen);
            return reassignable && signature.kind !== 'value' ? OPAQUE : signature;
        }
        if (ts.isCallExpression(init)) {
            const signature = callSignature(mod, init, exportName, seen);
            return reassignable ? OPAQUE : signature;
        }
        if (ts.isNewExpression(init) || ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init) || ts.isClassExpression(init)) {
            return OPAQUE;
        }
        return unhandled(mod, init, exportName, 'the initializer');
    }

    function callSignature(mod, call, exportName, seen) {
        const callee = stripParens(call.expression);
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') {
            const target = bindTarget(mod, stripParens(callee.expression), exportName, seen);
            if (!target) return OPAQUE;
            const bound = Math.max(call.arguments.length - 1, 0);
            return target.kind === 'fn' || target.kind === 'async'
                ? { kind: target.kind, params: dropLeading(target.params, bound) }
                : OPAQUE;
        }
        if (ts.isIdentifier(callee)) {
            const resolved = resolveLocal(mod, callee.text, new Set());
            const wrapperKind = resolved && ts.isFunctionDeclaration(resolved.node) && resolved.node.name
                ? WRAPPERS.get(`${resolved.mod.rel}#${resolved.node.name.text}`)
                : undefined;
            if (wrapperKind) {
                const wrapped = call.arguments[0] && stripParens(call.arguments[0]);
                let fn;
                let fnMod = mod;
                if (wrapped && (ts.isArrowFunction(wrapped) || ts.isFunctionExpression(wrapped))) {
                    fn = wrapped;
                } else if (wrapped && ts.isIdentifier(wrapped)) {
                    const target = resolveLocal(mod, wrapped.text, new Set());
                    if (target && ts.isFunctionDeclaration(target.node)) {
                        fn = target.node;
                        fnMod = target.mod;
                    }
                }
                if (!fn || fn.asteriskToken) return OPAQUE;
                return { kind: wrapperKind, params: functionSignature(fnMod, fn, exportName).params };
            }
        }
        return OPAQUE;
    }

    /** The signature of a `.bind` target, or null when it can't be resolved. */
    function bindTarget(mod, target, exportName, seen) {
        if (ts.isIdentifier(target)) {
            const signature = declarationSignature(resolveLocal(mod, target.text, seen), exportName, seen);
            return signature.kind === 'opaque' ? null : signature;
        }
        if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(stripParens(target.expression))) {
            const owner = resolveLocal(mod, stripParens(target.expression).text, new Set());
            if (!owner || !ts.isVariableDeclaration(owner.node) || !(owner.node.parent.flags & ts.NodeFlags.Const)) return null;
            const init = owner.node.initializer && stripParens(owner.node.initializer);
            if (!init || !ts.isNewExpression(init) || !ts.isIdentifier(init.expression)) return null;
            const cls = resolveLocal(owner.mod, init.expression.text, new Set());
            if (!cls || !ts.isClassDeclaration(cls.node)) return null;
            const method = cls.node.members.find(member => ts.isMethodDeclaration(member)
                && ts.isIdentifier(member.name) && member.name.text === target.name.text
                && !(ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static));
            return method && method.body ? functionSignature(cls.mod, method, exportName) : null;
        }
        return null;
    }

    return {
        /** The signature of `name` as exported by public/script.js. */
        signature(name) {
            const seen = new Set();
            return declarationSignature(resolveExport('public/script.js', name, seen), name, seen);
        },
    };
}

/** Maps an import specifier to a repo-relative path, or null for a bare specifier. */
function resolveSpecifier(fromRel, specifier) {
    if (specifier.startsWith('/')) return path.posix.join('public', specifier);
    if (specifier.startsWith('./') || specifier.startsWith('../')) return path.posix.join(path.posix.dirname(fromRel), specifier);
    return null;
}

export function compareNames(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function paramToken(param) {
    if (param.type === 'rest') return `...${param.name}`;
    if (param.type === 'object') {
        return `${param.name}{${param.props.map(p => p.name + (p.optional ? '?' : '')).join(',')}}${param.optional ? '?' : ''}`;
    }
    return param.name + (param.optional ? '?' : '');
}

export function formatSignature(name, signature) {
    return [name, signature.kind, ...(signature.params ?? []).map(paramToken)].join(' ');
}

export function formatSignatures(commit, entries) {
    return `${commit}\n${entries.map(([name, signature]) => formatSignature(name, signature)).join('\n')}\n`;
}

function parseParam(token) {
    if (token.startsWith('...')) {
        const name = token.slice(3);
        return NAME_PATTERN.test(name) ? { type: 'rest', name } : null;
    }
    const object = /^([A-Za-z_$][\w$]*)\{([^{}]*)\}(\?)?$/.exec(token);
    if (object) {
        const props = object[2] === '' ? [] : object[2].split(',').map(prop => {
            const optional = prop.endsWith('?');
            const name = optional ? prop.slice(0, -1) : prop;
            return NAME_PATTERN.test(name) ? { name, optional } : null;
        });
        if (props.includes(null)) return null;
        return { type: 'object', name: object[1], optional: Boolean(object[3]), props };
    }
    const optional = token.endsWith('?');
    const name = optional ? token.slice(0, -1) : token;
    if (name === '[]') return { type: 'array', name, optional };
    return NAME_PATTERN.test(name) ? { type: 'plain', name, optional } : null;
}

/** Parses the record file; throws SignatureError when it is malformed. */
export function parseSignatures(text, label) {
    if (!text.endsWith('\n')) throw new SignatureError(`${label} is malformed: it must end with a newline.`);
    const [commit, ...lines] = text.slice(0, -1).split('\n');
    if (!/^[0-9a-f]{40}$/.test(commit)) {
        throw new SignatureError(`${label} is malformed: its first line must be the full upstream/staging commit hash, got ${JSON.stringify(commit)}.`);
    }
    const entries = lines.map((line, i) => {
        const bad = (why) => new SignatureError(`${label}:${i + 2} is malformed: ${why}: ${JSON.stringify(line)}.`);
        const [name, kind, ...tokens] = line.split(' ');
        if (!name || !NAME_PATTERN.test(name)) throw bad('no export name');
        if (!['value', 'opaque', 'fn', 'async'].includes(kind)) throw bad('the kind must be value, opaque, fn or async');
        if ((kind === 'value' || kind === 'opaque') && tokens.length > 0) throw bad(`a ${kind} has no params`);
        const params = tokens.map(parseParam);
        if (params.includes(null)) throw bad('a param token is not in the record notation');
        if (formatSignature(name, { kind, params: kind === 'fn' || kind === 'async' ? params : undefined }) !== line) throw bad('it is not in canonical form');
        if (i > 0 && compareNames(lines[i - 1].split(' ')[0], name) >= 0) throw bad('names must be sorted and unique');
        return [name, kind === 'fn' || kind === 'async' ? { kind, params } : { kind }];
    });
    return { text, commit, entries };
}

/** Problems with `ours` against upstream's recorded `up` signature of `name`. */
export function compareSignature(name, up, ours) {
    const show = (s) => formatSignature(name, s);
    const problem = (why) => `${name}: ${why}\n    upstream: ${show(up)}\n    ours:     ${show(ours)}`;
    if (up.kind === 'opaque') return [];
    if (up.kind === 'value') {
        return ours.kind === 'fn' || ours.kind === 'async' ? [problem('upstream exports a value; ours is callable.')] : [];
    }
    if (ours.kind === 'opaque') return [problem('upstream exports a function; ours can\'t be proven callable. Restructure it so its value can be analysed.')];
    if (ours.kind === 'value') return [problem('upstream exports a function; ours is not callable.')];
    const problems = [];
    if (ours.kind !== up.kind) problems.push(problem(`upstream's is ${up.kind === 'async' ? 'async' : 'sync'}; ours is ${ours.kind === 'async' ? 'async' : 'sync'}.`));
    const restAt = ours.params.findIndex(p => p.type === 'rest');
    for (let i = 0; i < up.params.length; i++) {
        const u = up.params[i];
        const o = ours.params[i];
        if (restAt !== -1 && i > restAt) {
            problems.push(problem(`upstream's param ${i + 1} \`${paramToken(u)}\` falls into ours' rest param, which doesn't carry its name.`));
            continue;
        }
        if (!o) {
            problems.push(problem(`ours has fewer positional params (${ours.params.length}) than upstream (${up.params.length}).`));
            break;
        }
        if (u.type === 'rest' && o.type !== 'rest') {
            problems.push(problem(`upstream's param ${i + 1} is a rest param; ours isn't.`));
            continue;
        }
        if (o.type === 'rest') {
            if (u.type === 'object' || u.type === 'array' || u.name !== o.name) {
                problems.push(problem(`param ${i + 1} \`${paramToken(u)}\` is renamed to \`${paramToken(o)}\`.`));
            }
            continue;
        }
        if (u.type !== o.type) {
            problems.push(problem(`param ${i + 1} \`${paramToken(u)}\` is renamed to \`${paramToken(o)}\`.`));
            continue;
        }
        if (u.type === 'plain' && u.name !== o.name) {
            problems.push(problem(`param ${i + 1} \`${u.name}\` is renamed to \`${o.name}\`.`));
        }
        if (u.type === 'object') {
            if (u.name !== '_' && u.name !== o.name) {
                problems.push(problem(`param ${i + 1}'s JSDoc name \`${u.name}\` is \`${o.name}\` in ours.`));
            }
            for (const prop of u.props) {
                const match = o.props.find(p => p.name === prop.name);
                if (!match) problems.push(problem(`param ${i + 1} no longer takes the property \`${prop.name}\`.`));
                else if (prop.optional && !match.optional) problems.push(problem(`param ${i + 1}'s property \`${prop.name}\` is optional upstream and required in ours.`));
            }
        }
        if (u.optional && !o.optional) {
            problems.push(problem(`param ${i + 1} \`${paramToken(u)}\` is optional upstream and required in ours.`));
        }
    }
    for (let i = up.params.length; i < ours.params.length; i++) {
        const o = ours.params[i];
        if (o.type !== 'rest' && !o.optional) {
            problems.push(problem(`ours adds a required param ${i + 1} \`${paramToken(o)}\`; only optional params may be added.`));
        }
    }
    return problems;
}
