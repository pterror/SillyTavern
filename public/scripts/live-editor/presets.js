// The editor's built-in find-and-replace presets: markdown-aware text cleanup, and the line processors of
// desloppify (~/git/silliest/src/slices/chatbot-tools/desloppify.ts, by the same author) for character definitions.

import { chatMarkdownParser } from './grammar.js';
import { t } from '../i18n.js';

/** @typedef {import('./search.js').BuiltinPreset} BuiltinPreset */
/** @typedef {import('./search.js').PresetContext} PresetContext */

/**
 * Applies edits (ranges replaced with text) to a string, all at once.
 * @param {string} text
 * @param {{ from: number, to: number, insert: string }[]} edits Non-overlapping.
 */
function applyEdits(text, edits) {
    let out = '';
    let at = 0;
    for (const edit of [...edits].sort((a, b) => a.from - b.from)) {
        out += text.slice(at, edit.from) + edit.insert;
        at = edit.to;
    }
    return out + text.slice(at);
}

/**
 * Removes italics, reading the text as chat's markdown does: every emphasis loses its markers, bold stays, and bold
 * italics (`***x***`, `*__x__*`) stay whole. Where italics and bold only partly overlap, the italics go and the bold
 * part stays bold. Code, URLs and HTML aren't touched, since emphasis isn't read there.
 * @param {string} text
 * @returns {string}
 */
export function removeItalics(text) {
    const tree = chatMarkdownParser().parse(text);
    /** @type {{ from: number, to: number, insert: string }[]} */
    const edits = [];
    tree.iterate({
        enter: (node) => {
            if (node.name !== 'Emphasis') return;
            const marks = node.node.getChildren('EmphasisMark');
            if (marks.length < 2) return;
            const [open, close] = [marks[0], marks[marks.length - 1]];
            const fills = (/** @type {import('@lezer/common').SyntaxNode | null} */ inner, outerOpen, outerClose) =>
                inner !== null && inner.from === outerOpen.to && inner.to === outerClose.from;
            const strongInside = node.node.getChildren('StrongEmphasis').find(s => fills(s, open, close)) ?? null;
            const parent = node.node.parent;
            let insideStrong = false;
            if (parent?.name === 'StrongEmphasis') {
                const parentMarks = parent.getChildren('EmphasisMark');
                insideStrong = parentMarks.length >= 2 && fills(node.node, parentMarks[0], parentMarks[parentMarks.length - 1]);
            }
            if (strongInside || insideStrong) return;
            edits.push({ from: open.from, to: open.to, insert: '' }, { from: close.from, to: close.to, insert: '' });
        },
    });
    return applyEdits(text, edits);
}

const TYPOGRAPHY = {
    '‘': '\'', '’': '\'', '“': '"', '”': '"', '«': '"', '»': '"',
    '–': '-', '—': '-', '−': '-', '―': '-', '‑': '-', '‒': '-', '⁃': '-',
    '…': '...',
    '「': '"', '」': '"', '『': '"', '』': '"', '＂': '"',
};
const typographyRegex = new RegExp(`[${Object.keys(TYPOGRAPHY).join('')}]`, 'g');
const UNTOUCHED_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'URL', 'HTMLTag', 'HTMLBlock']);

/**
 * Typography to plain ASCII: curly and angle quotes and the other dialogue quote styles to `"` or `'`, every dash to
 * `-`, `…` to `...`. Code, URLs and HTML are left as they are.
 * @param {string} text
 * @returns {string}
 */
export function typographyToAscii(text) {
    const tree = chatMarkdownParser().parse(text);
    /** @type {{ from: number, to: number }[]} */
    const skip = [];
    tree.iterate({
        enter: (node) => {
            if (!UNTOUCHED_NODES.has(node.name)) return;
            skip.push({ from: node.from, to: node.to });
            return false;
        },
    });
    let out = '';
    let at = 0;
    for (const range of skip.sort((a, b) => a.from - b.from)) {
        out += text.slice(at, range.from).replace(typographyRegex, c => TYPOGRAPHY[c]) + text.slice(range.from, range.to);
        at = range.to;
    }
    return out + text.slice(at).replace(typographyRegex, c => TYPOGRAPHY[c]);
}

// ---- desloppify's line processors. Each takes a line and returns it changed, or undefined to drop it. ----

const SMART_QUOTE_REPLACEMENTS = { '‘': '\'', '’': '\'', '“': '"', '”': '"', '«': '"', '»': '"' };
const FIELD_NAME_REPLACEMENTS = { tall: 'Height', 'nick name': 'Nickname', character: 'Name' };
const PRESET_INSTRUCTION_WORDS = String.raw`OpenAI|char[}]?[}]?\s*will\s+not|roleplay\s+ignores|roleplay\s+allows|never\s+speak|not\s+speak|may\s+speak|only\s+speak|chat\s+replies|not\s+impersonate|don'?t\s+impersonate|only\s+reply|for\s+actions|dirty\s+talk|harsh\s+words?|vulgar\s+words?|censored\s+words?|speak\s+vulgarly|without\s+boundaries|avoid\s+repetition|avoid\s+repetitive|do\s+not\s+speak|explicit\s+content|one\s+paragraph|detailed\s+responses|deemed\s+nsfw|nsfw\s+filters|bypass\s+nsfw|controls?\s+actions|assume\s+consent|avoid\s+jargon|avoid[^\].]*formal|drive[^\].]*conversation|never[^\].]*repetition|progress[^\].]*sex|not[^\].]*allowed[^\].]*speak|progress[^\].]*scene|keep[^\].]*personality|no[^\].]*restrictions|no[^\].]*censorship|not[^\].]*restrict|not[^\].]*censor|not[^\].]*consent|nsfw[^\].]*allowed|engage[^\].]*roleplay|\d[^\].]*tokens|dialogue[^\].]*perverse|dialogue[^\].]*debauched|dialogue[^\].]*erotic|flowery[^\].]*eloquent|flowery[^\].]*dramatic|explicit[^\].]*uncensored|do[^\].]*emojis|is[^\].]*scenario|focus[^\].]*dialogues?`;
const presetInstructionRegex = new RegExp(String.raw`\s*\[?[^[\]]*?\b(?:${PRESET_INSTRUCTION_WORDS}|write[^\]]*moans)\b[^[\]]*?\]\s*|\s*[^.]*\b(?:${PRESET_INSTRUCTION_WORDS})\b[^.]*[.]?\s*`, 'gi');

/** @param {string} text */
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @type {Record<string, (line: string, context: PresetContext) => string | undefined>} */
const LINE_PROCESSORS = {
    'Remove Preset Instructions': (line) => {
        if (line === '') return line;
        const out = line.replace(presetInstructionRegex, '');
        return out === '' ? undefined : out;
    },
    'Remove W++': (line) => {
        const match = line.match(/^\s*\[?([^=:[\]()]+?)\s*(?:[:=]?\s*[([]|[:=])\s*([^)]*?)"?[\])\s.,;]*$/)
            ?? line.match(/^\s*\[([^=:[\]()]+?)\s*[:=]\s*([^\]]*?)"?[\]\s.,;]*$/);
        if (!match) return line;
        const [, name = '', rest = ''] = match;
        const values = rest.split('+').map(word => word.replace(/^\s*["“”]?\s*|\s*["“”]?\s*$/g, ''));
        return `${name}: ${values.join(', ')}`;
    },
    'Normalize Field Names': (line) => {
        const match = line.match(/^\s*([^:]+?):\s*(.*)$/);
        if (!match) return line;
        const [, name = '', rest = ''] = match;
        return `${FIELD_NAME_REPLACEMENTS[name.toLowerCase()] ?? name}: ${rest}`;
    },
    'Strip {{char}} Field Prefix': line => line.replace(/^\s*{{char}}'?s?_?\s*(.+)\s*:/, (_m, field) => `${field.replace(/^./, m => m.toUpperCase())}:`),
    'Strip \'Character\' Field Prefix': line => line.replace(/^\s*character'?s?_?\s*(.+)\s*:/, (_m, field) => `${field.replace(/^./, m => m.toUpperCase())}:`),
    'Capitalize Field Names': (line) => {
        const match = line.match(/^\s*([^:]+?):\s*(.*)$/);
        if (!match) return line;
        const [, name = '', rest = ''] = match;
        return `${name[0]?.toUpperCase() + name.slice(1)}: ${rest}`;
    },
    'Use Sentence Case': line => line.replace(/^.|(?<=^[\w\s]*:\s*).|[.]\s+(.)/g, c => c.toUpperCase()),
    'Remove Narration Instructions': (line) => {
        if (line === '') return line;
        const out = line.replace(/\s*\[\s*narration\b.*?\]\s*/gi, '');
        return out === '' ? undefined : out;
    },
    'Strip Leading Whitespace': line => line.replace(/^\s*/, ''),
    'Strip Trailing Whitespace': line => line.replace(/\s*$/, ''),
    'Strip Trailing Semicolon': line => line.replace(/\s*;\s*$/, ''),
    'Remove Bold and Italics Around Dialogue': line => line.replace(/([*]+)"(.+?)"\1$/, '"$2"'),
    'Replace Character Field Name With Name': line => line.replace(/^\s*{{char}}'?s?\s*:/, 'Name:'),
    // desloppify's `/[’]g/` only matched `’g`: every smart quote it lists is meant.
    'Replace Smart Quotes': line => line.replace(/[‘’“”«»]/g, match => SMART_QUOTE_REPLACEMENTS[match] ?? match),
    'Replace Hyphens': line => line.replace(/[–—−―‑‒⁃]/g, '-'),
    'Replace Bullet Points': line => line.replace(/^(\s*)[•]\s*/, '$1- '),
    'Human Readable Field Name': line => line.replace(/^\s*([^:[\]()]+?)\s*:/, (_m, field) => `${field.replace(/_+/g, ' ')}:`),
    'Replace Name With {{char}}': (line, { characterName }) => characterName
        ? line.replace(new RegExp('\\b' + escapeRegex(characterName) + '\\b', 'gi'), '{{char}}')
        : line,
    'Strip Empty Lines': line => (line === '' ? undefined : line),
    'Remove Horizontal Rules': line => (/^\s*---+\s*$/.test(line) ? undefined : line),
    'Remove Species: Human': line => (/^\s*species:\s*human(?:[/\w]*)\s*$/i.test(line) ? undefined : line),
};

/** desloppify's passes over the whole text rather than single lines. */
const WHOLE_TEXT = {
    'Inject Newlines Between Fields': text => text.replace(/(?<=[)]) (Name|Personality|Description|Body|Clothes|Clothing|Outfit|Likes|Dislikes|Way|Sexuality)/gi, '\n$1'),
    'Strip Surrounding Whitespace': text => text.replace(/^\s+|\s+$/g, ''),
    'Collapse Adjacent Newlines': text => text.replace(/\s*\n\s*\n\s*\n\s*/g, '\n\n'),
};

/** Processors that rely on a card's structure: `Name:`-style fields, W++, `{{char}}`, instructions to the model. */
const CHARACTER_DEFINITION = new Set([
    'Remove Preset Instructions', 'Remove W++', 'Normalize Field Names', 'Strip {{char}} Field Prefix',
    'Strip \'Character\' Field Prefix', 'Capitalize Field Names', 'Use Sentence Case', 'Remove Narration Instructions',
    'Replace Character Field Name With Name', 'Human Readable Field Name', 'Replace Name With {{char}}',
    'Remove Species: Human', 'Inject Newlines Between Fields',
]);

/** desloppify's default order. */
const DEFAULT_ORDER = [
    'Remove W++', 'Normalize Field Names', 'Replace Character Field Name With Name', 'Human Readable Field Name',
    'Strip {{char}} Field Prefix', 'Strip \'Character\' Field Prefix', 'Capitalize Field Names', 'Use Sentence Case',
    'Remove Preset Instructions', 'Remove Narration Instructions', 'Strip Leading Whitespace',
    'Strip Trailing Whitespace', 'Strip Trailing Semicolon', 'Remove Bold and Italics Around Dialogue',
    'Replace Smart Quotes', 'Replace Hyphens', 'Replace Bullet Points', 'Remove Species: Human',
    'Replace Name With {{char}}', 'Strip Surrounding Whitespace', 'Inject Newlines Between Fields',
    'Collapse Adjacent Newlines',
];

/** @param {string} name */
const slug = name => 'builtin:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * @param {string} name
 * @returns {(text: string, context: PresetContext) => string}
 */
function processorRun(name) {
    if (WHOLE_TEXT[name]) return text => WHOLE_TEXT[name](text);
    const processor = LINE_PROCESSORS[name];
    return (text, context) => text.split('\n').flatMap((line) => {
        const out = processor(line, context);
        return out === undefined ? [] : [out];
    }).join('\n');
}

/**
 * The same as running desloppify with its defaults: the line processors run line by line, each line through all of
 * them in order, then the whole-text passes.
 * @param {string} text
 * @param {PresetContext} context
 */
function desloppifyDefaults(text, context) {
    let out = WHOLE_TEXT['Inject Newlines Between Fields'](text);
    const lineNames = DEFAULT_ORDER.filter(name => LINE_PROCESSORS[name]);
    out = out.split('\n').flatMap((line) => {
        let current = line;
        for (const name of lineNames) {
            const next = LINE_PROCESSORS[name](current, context);
            if (next === undefined) return [];
            current = next;
        }
        return [current];
    }).join('\n');
    out = WHOLE_TEXT['Strip Surrounding Whitespace'](out);
    return WHOLE_TEXT['Collapse Adjacent Newlines'](out);
}

/** @returns {BuiltinPreset[]} */
export function builtinPresets() {
    const text = t`Text cleanup`;
    const card = t`Character definition cleanup`;
    /** @type {BuiltinPreset[]} */
    const presets = [
        { id: 'builtin:remove-italics', name: t`Remove italics`, group: text, run: removeItalics },
        { id: 'builtin:typography-to-ascii', name: t`Typography to plain characters`, group: text, run: typographyToAscii },
        { id: 'builtin:desloppify-defaults', name: t`Clean up character definitions (all of the below, in order)`, group: card, run: desloppifyDefaults },
    ];
    for (const name of [...Object.keys(LINE_PROCESSORS), ...Object.keys(WHOLE_TEXT)]) {
        presets.push({ id: slug(name), name, group: CHARACTER_DEFINITION.has(name) ? card : text, run: processorRun(name) });
    }
    return presets;
}
