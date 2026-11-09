// Lowest first: a property comes from the highest active layer that sets it, else from rest.
export const LOOK_STATES = ['rest', 'messagePointed', 'wordPointed', 'selected'] as const;

export type LookState = (typeof LOOK_STATES)[number];

export type Declaration = { property: string; value: string };

export type FontFace = { family: string; url: string; format: string };

// The declarations are sanitized and written as they are.
export type ResolvedLook = {
    layers: Partial<Record<LookState, Declaration[]>>;
    picture: { before: boolean; after: boolean };
    note: string | null;
    fonts: FontFace[];
};

// A style's id is made from its content, so it always means the same look. `things` lists every thing drawn, those with
// no look under NO_LOOK_STYLE, so a newer view that draws a thing without a look replaces an older view's rules for it.
export type Looks = { styles: Record<string, ResolvedLook>; things: Record<string, string> };

export const NO_LOOK_STYLE = 'none';

// What the name renderer draws: `thing` is the entity id (or `bookmark-<id>`), `shownAs` what the text is.
export type Named = { thing: string; text: string; shownAs: 'name' | 'title' | 'opening' };

export const NO_LOOKS: Looks = { styles: {}, things: {} };

// The looks of everything a tab draws, answered with every look's edit: each tab holds it open.
export const DRAWN_VIEW = 'looks.drawn';

// The element that counts as a name's message for "message pointed at": a chat message, a card, a row.
export const LOOK_SCOPE_CLASS = 'look-scope';
// Set on a name's own element while its thing is selected.
export const LOOK_SELECTED_ATTRIBUTE = 'data-selected';

export const lookClass = (thing: string): string => `look-${thing}`;

// The element around a name that holds its pictures and carries its note; the name's own span is inside it.
export const NAME_BOX_CLASS = 'name-box';
export const lookBoxClass = (thing: string): string => `look-box-${thing}`;
export const NAME_PICTURE_CLASS = 'name-picture';
export const namePictureClass = (side: 'before' | 'after'): string => `${NAME_PICTURE_CLASS}-${side}`;

export const nameClass = (named: Pick<Named, 'thing' | 'shownAs'>): string =>
    `named named-${named.shownAs} ${lookClass(named.thing)}`;

// Every layer's selector has the specificity of one class, so the layers win by their order alone.
export function lookSelector(thing: string, state: LookState): string {
    const own = `.${lookClass(thing)}`;
    switch (state) {
        case 'rest':
            return own;
        case 'messagePointed':
            return `:where(.${LOOK_SCOPE_CLASS}:hover, .${LOOK_SCOPE_CLASS}:focus-within) ${own}`;
        case 'wordPointed':
            return `${own}:where(:hover, :focus-visible)`;
        case 'selected':
            return `${own}:where([${LOOK_SELECTED_ATTRIBUTE}])`;
    }
}

export function lookCss(thing: string, look: ResolvedLook): string {
    const rules: string[] = [];
    for (const state of LOOK_STATES) {
        const declarations = look.layers[state];
        if (!declarations || declarations.length === 0) continue;
        const body = declarations.map(({ property, value }) => `${property}: ${value};`).join(' ');
        rules.push(`${lookSelector(thing, state)} { ${body} }`);
    }
    return rules.join('\n');
}

const cssString = (text: string): string =>
    `"${text.replace(/[^\w ,.:!?'()-]/gu, (c) => `\\${c.codePointAt(0)?.toString(16) ?? ''} `)}"`;

// The picture's sides and the note, which sit around the name's span and never inside it.
export function lookPlacementCss(thing: string, look: ResolvedLook): string {
    const box = `.${lookBoxClass(thing)}`;
    const rules: string[] = [];
    for (const side of ['before', 'after'] as const) {
        if (look.picture[side]) rules.push(`${box} > .${namePictureClass(side)} { display: inline-block; }`);
    }
    if (look.note !== null) rules.push(`${box}::after { content: ${cssString(look.note)}; }`);
    return rules.join('\n');
}

export const thingCss = (thing: string, look: ResolvedLook): string =>
    [lookCss(thing, look), lookPlacementCss(thing, look)].filter((css) => css !== '').join('\n');

export const fontFaceCss = (face: FontFace): string =>
    `@font-face { font-family: "${face.family}"; src: url("${face.url}") format("${face.format}"); font-display: swap; }`;
