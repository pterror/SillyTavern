// Lowest first: a property comes from the highest active layer that sets it, else from rest.
export const LOOK_STATES = ['rest', 'messagePointed', 'wordPointed', 'selected'] as const;

export type LookState = (typeof LOOK_STATES)[number];

export type Declaration = { property: string; value: string };

export type FontFace = { family: string; url: string; format: string };

// The part of a picture the small picture shows, as fractions of the picture's width and height.
export type PictureCrop = { x: number; y: number; width: number; height: number };

// The declarations are sanitized and written as they are. `image`: the URL of an image drawn instead of the thing's
// own picture; `crop`: the part of it shown.
export type ResolvedLook = {
    layers: Partial<Record<LookState, Declaration[]>>;
    picture: { before: boolean; after: boolean; crop: PictureCrop | null; image: string | null };
    note: string | null;
    fonts: FontFace[];
};

// A mark is never selected.
export const MARK_STATES = ['rest', 'messagePointed', 'wordPointed'] as const;
export type MarkState = (typeof MARK_STATES)[number];
export const MARK_STYLES = ['dotted', 'dashed', 'large-dots', 'none'] as const;
export type MarkStyle = (typeof MARK_STYLES)[number];
// `color` is a sanitized CSS color; `opacity` from 0 to 1 fades the mark, never the words.
export type MarkLayer = { style: MarkStyle; color: string; opacity: number };
export type ResolvedMark = Record<MarkState, MarkLayer>;

export const TRIGGER_MARK_CLASS = 'trigger-mark';

// A style's id is made from its content, so it always means the same look. `things` lists every thing drawn, those with
// no look under NO_LOOK_STYLE, so a newer view that draws a thing without a look replaces an older view's rules for it.
export type Looks = { styles: Record<string, ResolvedLook>; things: Record<string, string>; mark?: ResolvedMark };

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
// On an element around names, shows them as if their message, or they themselves, were pointed at (the Look screen's
// scenes and its preview of a state).
export const LOOK_SHOWS_MESSAGE_POINTED_CLASS = 'look-shows-message-pointed';
export const LOOK_SHOWS_WORD_POINTED_CLASS = 'look-shows-word-pointed';

export const lookClass = (thing: string): string => `look-${thing}`;

// The element around a name that holds its pictures and carries its note; the name's own span is inside it.
export const NAME_BOX_CLASS = 'name-box';
export const lookBoxClass = (thing: string): string => `look-box-${thing}`;
export const NAME_PICTURE_CLASS = 'name-picture';
// The custom property a place sets on a small picture's box to the thing's own picture.
export const NAME_PICTURE_PROPERTY = '--name-picture';
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
            return `:where(.${LOOK_SCOPE_CLASS}:hover, .${LOOK_SCOPE_CLASS}:focus-within, .${LOOK_SHOWS_MESSAGE_POINTED_CLASS}) ${own}`;
        case 'wordPointed':
            return `${own}:where(:hover, :focus-visible, .${LOOK_SHOWS_WORD_POINTED_CLASS} *)`;
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

const percent = (n: number): string => `${Math.round(n * 10_000) / 100}%`;

// The background a small picture's box draws to show the crop: the picture scaled so the crop fills the box.
export function cropCss(crop: PictureCrop): string {
    const at = (start: number, size: number) => (size >= 1 ? '0%' : percent(start / (1 - size)));
    return `background-size: ${percent(1 / crop.width)} ${percent(1 / crop.height)}; background-position: ${at(crop.x, crop.width)} ${at(crop.y, crop.height)};`;
}

// The picture's sides, what it shows, and the note, which sit around the name's span and never inside it.
export function lookPlacementCss(thing: string, look: ResolvedLook): string {
    const box = `.${lookBoxClass(thing)}`;
    const rules: string[] = [];
    for (const side of ['before', 'after'] as const) {
        if (look.picture[side]) rules.push(`${box} > .${namePictureClass(side)} { display: inline-block; }`);
    }
    const shows = [
        ...(look.picture.image === null ? [] : [`background-image: url("${look.picture.image}");`]),
        ...(look.picture.crop === null ? [] : [cropCss(look.picture.crop)]),
    ];
    if (shows.length > 0) rules.push(`${box} > .${NAME_PICTURE_CLASS} { ${shows.join(' ')} }`);
    if (look.note !== null) rules.push(`${box}::after { content: ${cssString(look.note)}; }`);
    return rules.join('\n');
}

export const thingCss = (thing: string, look: ResolvedLook): string =>
    [lookCss(thing, look), lookPlacementCss(thing, look)].filter((css) => css !== '').join('\n');

// No specificity, so custom CSS restyles the mark through its class alone; the states win by their order.
export function markSelector(state: MarkState): string {
    const mark = `.${TRIGGER_MARK_CLASS}`;
    switch (state) {
        case 'rest':
            return `:where(${mark})`;
        case 'messagePointed':
            return `:where(.${LOOK_SCOPE_CLASS}:hover, .${LOOK_SCOPE_CLASS}:focus-within, .${LOOK_SHOWS_MESSAGE_POINTED_CLASS}) :where(${mark})`;
        case 'wordPointed':
            return `:where(${mark}:hover, ${mark}:focus-visible, .${LOOK_SHOWS_WORD_POINTED_CLASS} ${mark})`;
    }
}

// The mark span's own underline, which no name inside it can take away; opacity fades only the line.
export function markDeclarations({ style, color, opacity }: MarkLayer): string {
    if (style === 'none') return 'text-decoration-line: none;';
    const paint =
        opacity >= 1 ? color : `color-mix(in srgb, ${color} ${Math.round(opacity * 1000) / 10}%, transparent)`;
    const large = style === 'large-dots';
    return [
        'text-decoration-line: underline;',
        `text-decoration-style: ${style === 'dashed' ? 'dashed' : 'dotted'};`,
        `text-decoration-color: ${paint};`,
        `text-decoration-thickness: ${large ? '0.2em' : 'auto'};`,
        `text-underline-offset: ${large ? '0.2em' : 'auto'};`,
    ].join(' ');
}

export const markCss = (mark: ResolvedMark): string =>
    MARK_STATES.map((state) => `${markSelector(state)} { ${markDeclarations(mark[state])} }`).join('\n');

export const markShown = (mark: ResolvedMark): boolean =>
    MARK_STATES.some((state) => mark[state].style !== 'none' && mark[state].opacity > 0);

export const fontFaceCss = (face: FontFace): string =>
    `@font-face { font-family: "${face.family}"; src: url("${face.url}") format("${face.format}"); font-display: swap; }`;
