# Looks: the store and the server

How a name is drawn (`worldbuilding.md`, Looks): what is stored, what the sanitizer lets in, how a thing's look
resolves, and how every answer that draws names carries the looks it needs. The area is `@st/looks`
(`packages/areas/looks`), its store side `src/looks-store.js`, the delivery shape and the rules the page writes
`@st/protocol/looks`.

## The things and where their look is

Every named thing is a `thing`, the value `Named.thing` carries and the name's class `look-<thing>` holds.

| Thing | `thing` | Record | Its look |
|---|---|---|---|
| an entry | its entity id | the entry (`TYPE.entry`, key `<book>:<uid>`) | `extensions.look`, the entry's field `\u0001look`; round-trips through world files and card books with the rest of `extensions` |
| a world | the book's entity id | the book (`TYPE.book`) | the book's field `\u0001look`, a world file's top-level `look` |
| a character | its entity id | the character (`TYPE.character`) | the character's field `\u0001look`; not part of its card |
| a persona | its entity id | the persona (`TYPE.persona`) | the persona's field `\u0001look` |
| a bookmark | `bookmark-<id>` | a chat position | an entity of its own, `TYPE.look` keyed `bookmark:<id>` |

Entity ids are unique across every entity type of a store. A bookmark is not an entity: it is a position of the chat
store, whose ids are counted apart from the entities', so a bare id could name an entity too; its `thing` says what
it is, and its look is an entity of its own under the bookmark's id. Deleting a bookmark by its own action, or a chat's
root bookmarks with the chat, deletes its look in the same commit (`bookmarkLookDeletes`); a bookmark that goes with
its message leaves its look entity behind, which nothing can reach again, since position ids are never given twice.

A character's and a persona's other writes never touch their look: a card's write and a settings save each leave the
field out of what they compare (`withoutLook`), and neither their reads nor the card see it. An entry's and a world's
look is part of what their whole writes write, so it passes the sanitizer there too (`lookToStore` in
`world-info-engine.js`): an import, a card book, a script's save.

## The stored look

```json
{
  "rest": [{ "property": "color", "value": "teal" }],
  "messagePointed": [], "wordPointed": [], "selected": [],
  "picture": { "before": true, "after": false, "crop": { "x": 0.25, "y": 0.1, "width": 0.5, "height": 0.33 } },
  "note": "the heir",
  "uses": ["8a4e7c1e-0f63-4d2b-9a8e-2b7c3d1f5e60"]
}
```

Every part is optional; a level that leaves one out takes it from the levels under it. A layer is a list of at most
`DECLARATIONS_PER_LAYER_AT_MOST` (32) declarations, one per property, in the order they were last set. `picture` says on
which sides the thing's small picture goes, each side set or not; `note` is at most 80 characters, and an empty note
says "no note" over the levels under it. `uses` lists at most `MAX_USES` (3) shared looks by id. A value of another
shape is no look: it is kept as written (a third party's `look` extension isn't ours to rewrite) and draws nothing.

The picture and the note are one per look, not per state layer: they are content placed beside and above the name,
and the layers are declarations on the name's own span.

### The small picture

A thing's small picture is its own picture (a character's avatar, a persona's image; an entry, a world and a bookmark
have none yet) unless its look says otherwise: `picture.crop` is the part shown, as fractions of the picture's width
and height (each side at least `CROP_SIDE_AT_LEAST`, 0.05), and `picture.image` another image drawn instead, by id.
The Look screen writes both on the thing's own look (`looks.cropPicture`, `looks.uploadPicture`,
`looks.useOwnPicture`), so they are stored with the thing like the rest of its look. An image is stored once by its
bytes like a font: `<user>/look-images/<sha256>.<ext>` (PNG, JPEG, WebP or GIF by its first bytes, at most 4 MB),
served at `/look-images/<id>` with a cache that never asks again (`src/endpoints/fonts.js`). No action removes one.

A place that draws pictures beside names gives the name its thing's own picture (`picture`), which the renderer sets
as the box's `--name-picture`; the thing's rules draw the crop (the picture scaled so the crop fills the box,
`cropCss`) and another image over it, so the delivered stylesheet stays the only page-side copy of a look.

### Shared looks

A shared look is `{ name, look }` under an id made at random (a UUID), so an id never means two looks, in one store or
across stores:

- **in a world**: the book's field `\u0001sharedLook:<id>`, a world file's `sharedLooks: [{ id, name, look }]`, read and
  written as `relationKinds` is (`bookValues`, `assembleBook`); a duplicate of the world copies them.
- **the user's**: the field `shared:<id>` of the user's looks, the one `TYPE.look` entity keyed `user`, which also holds
  the theme (`theme`). They are in no export.

A thing names a shared look by its id alone, and resolution looks for it in the thing's world, then among the user's.
So moving a shared look between its world and the user (`looks.moveShared`) is one commit of two fields, and nothing
that uses it is rewritten; a world's file can carry its entries' `uses` as they are. A shared look of world W is used
only by W's entries and W itself (`looks.use` and `looks.makeShared` refuse others); a user's look moved into W is no
longer found from other worlds, and is found again if it moves back. A deleted shared look, or one a thing can't
reach, is left out of its resolution; the Look screen lists it with no name, so it can be dropped
(`looks.stopUsing`). A shared look uses no other.

The theme is a look with no `uses`.

### The trigger mark

The words that brought an entry into a reply are marked in the chat by a span of their own (`trigger-mark`,
`TRIGGER_MARK_CLASS`), outside any name's span. How it is drawn is the theme's: the field `mark` of the user's looks,
beside `theme`, read with it in one read. Per state of the mark's own (`rest`, `messagePointed`, `wordPointed`; a mark
is never selected), a style (`dotted`, `dashed`, `large-dots`, `none`), a color (one `text-decoration-color` the
sanitizer lets in) and an opacity (0 to 1):

```json
{ "rest": { "style": "none" }, "messagePointed": { "style": "dotted", "opacity": 0.6 } }
```

Each state is its own settings over the states below it, over the default `dotted` in the text's color at full opacity
(`resolveMark`), so "only when pointing at the message" is `none` at rest and `dotted` when the message is pointed at.
A stored value of another shape is left out (`storedMark`). The rules (`markCss`) are the mark span's own underline,
which no name inside it can take away; the opacity fades only the line (`color-mix` with `transparent`), never the
words. Each selector is wrapped in `:where()`, so it has no specificity and custom CSS restyles the mark through its
class alone; the states win by their order. A mark that no state draws (`markShown`) is not drawn at all: the words
are plain text with no card on pointing.

### Fonts

An uploaded font is stored once by its bytes: `<user>/fonts/<sha256>.<ext>`, `ext` from its first bytes (WOFF2, WOFF,
TTF, OTF; at most 4 MB). Its id is that file name. A world lists its fonts as book fields `\u0001font:<id>` = the
name it was given; a whole-world save keeps them (they are no part of a world file's read), an export carries them
with their bytes (`fonts: [{ id, name, data }]`, base64), an import writes the bytes under their hash first and lists
only the fonts it could, and a duplicate lists the same fonts. Two worlds with the same font hold one file. Fonts are
served at `/fonts/<id>` with a cache that never asks again, since an id never names other bytes (`src/endpoints/fonts.js`).
No action removes a font, so no file is ever removed yet.

The app's own fonts are `noto-sans` and `noto-sans-mono`, which the page loads already.

## The sanitizer

`sanitizeDeclaration` is the only way into a stored look: the looks area's every edit, and every whole write of an
entry or a world. A declaration outside the limits is not stored, and the edit answers each refused one with why
(`answer.refused: [{ property, value, why }]`). CSS text (`looks.writeCss`) is parsed with `@adobe/css-tools` as the
declarations of one rule; anything but declarations (a brace, a selector, an at-rule, a parse error) refuses the whole
text.

Every value: printable ASCII only (no escape, control or look-alike character), and outside strings no `\`, `;`, `{`,
`}`, `!` (so no `!important`), `@`, `<`, `>`, `` ` `` or comment; strings only inside `url()` and `font-family`; every
`(` closed; at most 2,048 characters. Each property allows only the functions and words below; inside a function any
word is allowed (`to right`, a color's name). The CSS-wide words (`inherit` and the rest) are allowed everywhere.

| Property | Allowed | Why |
|---|---|---|
| `color`, `background-color`, `-webkit-text-fill-color`, `text-decoration-color`, `-webkit-text-stroke-color` | colors: `#` hex, color functions (`rgb`…`oklch`, `color`, `color-mix`, `light-dark`, `var`), `calc`/`min`/`max`/`clamp`, any word | paints the span's own text and box |
| `background-image` | gradients, `url()` (http, https, a `data:image/` or a path), color functions, `none` | gradient and image text with `background-clip: text`; `url()` is allowed (owner) |
| `background-clip`, `-webkit-background-clip` | `text`, the box words | clips the span's own background to its letters |
| `background-size`, `-position`, `-repeat` | lengths and their words | where the span's own background sits inside it |
| `text-shadow` | lengths and colors | drawn around the letters, takes no space |
| `filter` | `drop-shadow()`, `blur()`, `none` | glow and blur; no `url()`, which could name an element of the page |
| `-webkit-text-stroke`, `-width`, `paint-order` | lengths, colors, the order words | outline drawn on the letters |
| `text-decoration-line` | `none`, `underline`, `overline`, `line-through` | drawn in the span's own line |
| `text-decoration-style` | `solid`, `double`, `wavy` | dotted and dashed belong to the trigger mark, so no name can pass for one |
| `text-decoration-thickness`, `text-underline-offset`, `text-underline-position` | lengths and their words | the underline's own shape |
| `letter-spacing`, `word-spacing` | `normal`, px from −4 to 16, em, rem or ch from −0.25 to 1 | changes the name's width only by its letters, bounded so it can't push the line apart |
| `font-weight` | 1 to 1000, `normal`, `bold`, `bolder`, `lighter` | |
| `font-style` | `normal`, `italic`, `oblique` | |
| `font-variant-caps` | the caps words | small capitals |
| `font-family` | one font, the app's (`noto-sans`) or one of the thing's world's (its id, quoted), and generic fallbacks | a look names a font, the app writes its `@font-face`; a theme, a character, a persona, a bookmark and a user's shared look have no world, so only the app's |
| `opacity` | 0 to 1, or 0% to 100% | |
| `animation-name` | `none`, `shimmer`, `breathe`, `flicker`, `drift`, `float` | only the app's keyframes (`look-<name>`), so a look can't move or size the span by its own |
| `animation-duration`, `-delay`, `-timing-function`, `-iteration-count`, `-direction`, `-fill-mode`, `-play-state` | times, timing functions, their words | |

Everything else is refused, among them `position`, `margin`, `padding`, `display`, `width`, `height`, `font-size`,
`line-height`, `transform`, `content`, `z-index`, custom properties (`--x`) and every shorthand (`background`,
`animation`, `text-decoration`, `font`), whose longhands are listed one by one. The page reserves the name's line and
its picture's box with its own CSS, so nothing depends on the span's box.

## Resolution

Per thing, the levels in order, most specific last: the theme; the thing's world's shared looks (its `uses`) and the
world's own look, when it has a world and isn't it; the thing's shared looks in the order it lists them; the thing.
Per state layer each property comes from the last level that sets it (and moves to the end of the layer's list, so a
longhand set above a shorthand wins), the picture's sides and the note likewise (`resolveLevels`). A font id becomes
its family (`look-font-<first 16 of the hash>`, or the app font's name) and the font's face is listed; an animation's
name becomes the app's keyframes' (`look-shimmer`).

**The selectors** (`lookSelector`, `@st/protocol/looks`), each at the specificity of one class, written in the layers'
order, so a property comes from the highest active state that sets it, else from rest:

| Layer | Selector | Why |
|---|---|---|
| rest | `.look-T` | |
| message pointed at | `:where(.look-scope:hover, .look-scope:focus-within, .look-shows-message-pointed) .look-T` | the element that counts as the name's message (a chat message, a card, a row) carries `look-scope`, so one rule serves every place a name is drawn; keyboard focus inside it counts as pointing |
| word pointed at or focused | `.look-T:where(:hover, :focus-visible, .look-shows-word-pointed *)` | the name's own element; focus by keyboard only, as pointing is |
| selected | `.look-T:where([data-selected])` | an attribute the name renderer sets, since `aria-selected` belongs to roles (option, row) a name's span doesn't have |

`look-shows-message-pointed` and `look-shows-word-pointed` on an element around names draw them as if pointed at: the
Look screen's scenes and its preview of a chosen state use them, so a scene is the same rules the app draws by.

**What one resolution reads**: its things' own looks (one read each, two for a bookmark); their worlds' looks (one each
not among the things); the theme (two: the user's looks' entity and its field); and each distinct shared look named by a
thing or its world, at most two reads (the world's field, then the user's), at most `SHARED_LOOKS_PER_READ` (64) of
them: `READS_OF_LOOKS_BESIDES_THINGS` = 3 + 2 × 64 = 131 besides one read per thing. Past 64 distinct shared looks a name
is drawn without the ones past the bound; I don't know what real worlds need. Nothing is read for a thing not drawn.
A thing's own worst case is 1 + 2 × `MAX_USES` = 7 reads, under the 10 a card's own take; that is what bounds `uses`.

## Delivery

Every view that draws names carries `looks: Looks`, the resolved looks of exactly the things it draws:

```ts
type Looks = { styles: Record<string, ResolvedLook>; things: Record<string, string>; mark?: ResolvedMark };
type ResolvedLook = { layers: Partial<Record<LookState, Declaration[]>>; picture: { before: boolean; after: boolean; crop: PictureCrop | null; image: string | null }; note: string | null; fonts: FontFace[] };
```

A style's id is the first 16 hex digits of its SHA-256, so a style id always means the same look, the entries of a
world with no look of their own share one style, and two views' looks merge by key. `things` lists every thing drawn:
one with no look at all is under `NO_LOOK_STYLE`, so a newer answer that draws a thing whose look was taken away
replaces the older answer's rules for it. The page writes each held thing's rules (`thingCss`: the layers' rules and
the picture's and the note's) and its fonts' faces (`fontFaceCss`) into one stylesheet, keeping a thing's rules from
the newest holder that drew it and dropping them when no holder draws it (`@st/page/looks`). `looks.drawn` also
carries the trigger mark as each state draws it (`mark`), whose rules the page writes after the things'.

The views carry a map, not a look per `Named`: one thing is often drawn many times in one view (a region's target in
every relations line), and a world's entries share a style.

Areas never import each other: the shape is the core's (`@st/protocol/looks`), and an area that draws names gets its
looks through a port (`looksOf(context, view, things)`), which `src/ui-wiring.js` gives it from the looks area. The
worldbuilding area wraps each of its views: it collects every `Named` in the value, the entries an entry's text links,
and the worlds the worlds list and the world header show (`thingsDrawn`), and adds their looks.

The looks area keeps, per session, the things each view drew when it was last read. `looks.drawn` is the looks of
everything the session's views draw; every tab holds it open from its start (an area's `openFromStart`, no request),
and every look edit answers it with the Look screen's view (`looks.look`), so the answer carries the changed looks of
everything the tab draws, and the user's other tabs get theirs pushed. A view that is read again replaces its things;
a session that goes drops them.

## The name renderer

One renderer draws every name of the app (`@st/page/name`): `Name` for the new page, `nameElement` with the same markup
for old page code (`start().names.element`). A name is

```html
<span class="name-box look-box-T">
  <!-- only where the place draws its things' pictures -->
  <span class="name-picture name-picture-before" style="--name-picture: url(…)" aria-hidden="true"></span>
  <span class="named named-name look-T" data-thing="T" data-selected>text</span>
  <span class="name-picture name-picture-after" style="--name-picture: url(…)" aria-hidden="true"></span>
</span>
```

The layers style the inner span; the picture sides are shown and the note is written (the box's `::after`, above the
name, taking no room in the line) by the thing's rules in the same stylesheet, so nothing of a look is drawn by
anything but that stylesheet. `data-selected` is set by the place that knows the thing is selected (the worldbuilding
overview's selection). The element that counts as a name's message carries `look-scope`: a chat message, a character
list row, a group's row and member, a persona, a chat in the chat picker and among the recent chats, a worldbuilding
card, an activations row.

The client holds every view's `looks` under the view's key (a part that patches adds to it). Old page code holds what
its own answers carry under the place that draws them (`public/scripts/name-holders.js`), and the server keeps the same
places as what the tab draws (`pageLooks` in `src/ui-wiring.js`):

| Place | Answer | Its things |
|---|---|---|
| `page.characters` | `/api/characters/query` asked with `draws` (rows or hashes; the hashes carry them after everything else, flag `0b1000000`) | the page's characters and its groups' members |
| `page.groupCandidates` | the same, for the group editor's candidates | the same |
| `page.chat` | `/api/chats/open` | the chat's character, or its group's members |
| `page.personas` | `/api/avatars/get` (also as a chat open's part) | every persona, with `things` by avatar |
| `page.chats` | `/api/chats/search` (the chat picker; a later page adds) | its bookmarks |
| `page.recent` | `/api/chats/recent` (an older page adds) | the recent chats' characters and bookmarks |
| `page.chatLinks` | every answer that carries a chat's messages (Names in the chat, below) | the entries the messages' names link |

A character's thing comes with it (`thing` on every character object and list row); a persona's from the persona
answer's `things`; a bookmark's with the chat row that names it (`thing`, `label_thing`). A list page asked with `draws`
is answered whole even when its token is unchanged, since its looks are part of the answer.

### Names in the chat

A message's stored text links the names of the entries of the chat's worlds where it writes them: the worlds a reply in
the chat reads, as generation chooses them (`chatWorlds`, `src/chat-links.js`: the ones used in every chat, the
character's own world unless its card's book stands in for it, its extra books, the chat's, the persona's; a group's
members' alike). A card's own book is not linked, since none of its entries opens on the worldbuilding page. Each
message is looked through as an entry's text is (The names a text writes, `worldbuilding-store.md`), every world's
names matched as that world matches them, and of the spans of all the worlds the first and longest are kept
(`linksAmong`). The links are never stored: every answer that carries messages carries theirs (`links`):

```ts
type ChatLinks = {
    messages: Record<string, { of: number; links: [from: number, to: number, thing: string][]; complete: boolean }>;
    entries: Record<string, { book: string; uid: number }>; // where each linked entry opens
    looks: Looks;
};
```

| Answer | Its messages |
|---|---|
| `/api/chats/open` (and a new chat's, a greeting's) | the chat's, newest first, holding `page.chatLinks` anew |
| a reply (its JSON's `assistant_links`, the stream's `stored_reply`) | the reply and the message sent with it |
| `/api/chats/message/edit`, `edit-batch`, `append`, `alternative`, `graft` | the messages written |
| `/api/chats/message/select` (a swipe, a switch of path) | the one chosen and the ones after it; with its ancestry, all |
| `/api/chats/links` | the messages the page shows that no answer looked through (at most 64) |

The messages of one answer share one part's reads, newest first (`CHAT_TEXT_LINK_READS_PER_ANSWER`, below). A message
the reads left can't look through whole is answered only when it is the answer's first, which had them all
(`complete: false`: the links found are right, and a later word may be a name it didn't reach, so the page claims
nothing about unlinked words); the rest are not answered. The page asks for a message no answer looked through when it
comes into view (`linkWhenSeen`), one request for those that come into view together. `of` is the hash of the text
looked through: the page draws the links only while the message's stored text is still that text.

The server keeps, per tab, the messages its last answers linked (at most 256, the newest answered first). A commit that
can change a name or the chat's worlds (an entry's or a world's fields, keys, creation, deletion or history; the names
offer; the worlds chosen; the chat's world) looks those messages through again and pushes them to the tab over its
change stream (`chat-links`), which the page takes as everything it holds.

The page draws a link through the one name renderer inside the message's rendered text, where the trigger marks are
drawn too (`renderDrawn`, `public/scripts/lore-mark-render.js`): only where the rendered text still holds the words, a
name only when its words are one run of text (one element), a mark around every piece of its words. A mark over the
whole of a name is drawn around the name's element, so no name's look can cover it; one over part of a name, inside it.
The name's element (`chat-link`) can be focused, which counts as pointing at it.

Pointing at a name or a marked word shows the card (`activations.point`, one request, answered by `activations.card`;
drawn by `cardNodes`, `@st/activations/page`): for a name, its entry's; for a marked word, each entry it brought up
(at most `CARD_ENTRIES_AT_MOST`, 8, and how many more). A card is the entry's look's image (when it draws one), its
name, its world, its relations in use, the opening of its text, and what brought it into the reply of the message it
is in when it came up. A click on a name opens its entry on the worldbuilding page with no request but the page's own;
a click on a marked word opens its entry, or the reply's list when the word brought up several. On a device that can't
point (`hover: none`), a tap shows the card from the bottom with Open.

The words that brought an entry into a reply are marked on every message, each message from its own reply's record:
the first reply after it on the chat's path, whose record says where its keys were found, by message and the hash of
the text it read. The page holds every message of the path with its record, so it draws the marks with no request.

### The motions

The app's keyframes (`look-shimmer`, `-drift`, `-breathe`, `-flicker`, `-float`, in `NAME_BASE_CSS`) each move only
what no effect sets and nothing that takes room, so a motion goes with every effect and never moves anything around
the name: shimmer (a glint passing) and drift (a slow light) are a mask over the letters, breathe and flicker fade
(opacity), float lifts the name by `top` (every name's span is `position: relative`, which moves nothing else).
Inside `look-still`, and everywhere when the device asks for reduced motion, names are drawn still.

## Actions

Each is one request; each edit answers `looks.look` and `looks.drawn` and, in `answer.refused`, the declarations it
didn't store. A level is `{ theme: true }`, `{ thing }` (a world's own look is its thing's) or
`{ shared: { id, world } }` (`world` null for the user's).

- `looks.open` (thing), `looks.close`: the Look screen's thing. `looks.look` is the screen: the thing's name
  (`named`), its small picture (its own picture's URL, and the image and crop its look shows instead), the levels it
  resolves through least specific first (`levels`: the theme, its world's shared looks and its world when it has one
  and isn't it, the shared looks it uses, the thing), each state as drawn with the level and the layer each declaration
  comes from (`shown`: the state's layer over the ones below it, values as stored), the picture's sides and the note
  with the level that sets them (`placement`), its own look as stored, the shared looks it uses (each with its look,
  or no name when it can't be found), the shared looks it can use (its world's and the user's, by name), the fonts it
  can name (each with its family and, uploaded, its face), and its looks. The page resolves nothing.
- `looks.setDeclarations` (level, state, `set`, `reset`): sets and resets properties of one layer of one level.
- `looks.writeCss` (thing, state, css, `replaces`, `newAt`): the CSS of a state's own layer as the thing shows it. Each
  declaration the text holds goes to the level that sets it in that layer (most specific first), unchanged ones to
  none; one no level sets goes to `newAt`, one of the thing's levels; each of `replaces` the text leaves out is taken
  off the level that sets it. Each level is written in one write, sanitized for its own fonts.
- `looks.setMark` (`change`: per mark state, a style, color or opacity, or null to leave it to the state below),
  `looks.resetMark`: the trigger mark. `looks.theme` is the theme settings' part: the mark as stored and as each state
  draws it, and the user's own shared looks by name. The mark's edits, and the edits of the user's shared looks,
  answer it too.
- `looks.setPicture` (level, before, after: each true, false, or null to leave it to the levels under), `looks.setNote`
  (level, note or null).
- `looks.makeShared` (name, world or null, `usedBy` or null: a thing that uses it at once, last), `renameShared`,
  `deleteShared`, `moveShared` (to a world or null).
- `looks.use` (thing, shared, `before` another of its shared looks or null for last; moving it when used already),
  `looks.stopUsing`.
- `looks.applyTo` (thing, what: a state's properties, the picture's sides or the note, `from` the level that shows
  it, `to` another of the thing's levels or a new shared look `{ newShared: { name, world } }` made and used last in
  the same request): the values as `from` sets them (or as the state shows them, when `from` doesn't set them in
  that layer) are written at `to`, sanitized for `to`'s fonts; when `to` is less specific (a new shared look always
  is), they are taken off `from`, so the name looks the same and the effect now applies to everything `to` draws.
  Moving onto a more specific level keeps `from` as it is for everything else it draws.
- `looks.cropPicture` (thing, crop or null for the whole picture), `looks.uploadPicture` (thing, the file),
  `looks.useOwnPicture` (thing).
- `looks.uploadFont` (world, name, the file): answers the font's id.

## What carrying looks costs worldbuilding

A drawn name costs one more read (`READS_PER_LOOK`), so a drawn card costs 12 (its name and its relation's target), a
label 5, a mention checked 9, and each entry a text names one more than its two; and each view of a part that draws
names may read the 131 besides its things (`READS_OF_LOOKS_PER_PART`, six views: 786). So one read draws 1,571 cards
(was 1,971), a text is looked through for names up to 6,286 reads (about 6,200 characters, was 9,800), "Look further"
comes every 1,047 entries (was 1,232), and a selection holds 1,571 picked entries (was 1,971).

## Open

- The marks of what the next reply will bring up, and marks in the unsent message.
- A picture of their own for entries, worlds and bookmarks: they draw another image, or none.
- Removing a font from a world, and removing a font file no world lists.
- Names drawn in a `<select>`'s options or a `title` (the world link popups, the world button's title) can't be drawn
  by the renderer; they stay plain until those controls are drawn as lists.
- A name in the unsent message.
- The entries of a card's own book are not linked in the chat: they don't open on the worldbuilding page.
- A message is looked through at about one read per character that isn't white space, in each world with names (a
  world with none costs one read): an answer links about 11,800 such characters per world with names, so a chat of long
  messages is linked newest first and the rest as they come into view. I don't know what real chats need.
