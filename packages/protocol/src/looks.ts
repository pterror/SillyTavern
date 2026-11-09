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

// A style's id is made from its content, so it always means the same look. A drawn thing missing from `things` has no
// look.
export type Looks = { styles: Record<string, ResolvedLook>; things: Record<string, string> };

export const NO_LOOKS: Looks = { styles: {}, things: {} };

// The element that counts as a name's message for "message pointed at": a chat message, a card, a row.
export const LOOK_SCOPE_CLASS = 'look-scope';
// Set on a name's own element while its thing is selected.
export const LOOK_SELECTED_ATTRIBUTE = 'data-selected';

export const lookClass = (thing: string): string => `look-${thing}`;

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

export const fontFaceCss = (face: FontFace): string =>
    `@font-face { font-family: "${face.family}"; src: url("${face.url}") format("${face.format}"); font-display: swap; }`;
