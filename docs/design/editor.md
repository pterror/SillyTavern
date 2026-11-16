# Editor

One editor component for every text field that goes into the prompt: card fields, messages, reasoning, the chat box,
greetings and other alternatives, worldbuilding text, prompt manager prompts, author's note, persona description.

## Model

- The text is the source of truth, exactly as written: the prompt is that text. The editor draws over it and never
  changes it to draw it.
- CodeMirror with a lezer markdown grammar; the syntax tree keeps every character and is reparsed incrementally.
  A document tree (ProseMirror) would be a second copy of the text that must be kept in step with it.
- How text looks is defined once: one set of styles for message text, applied by one class to rendered messages and
  every editor. The box around a message (border, padding) is separate from it. No copying of computed styles.

## Editing and reading

- An editor shows formatting marks dimmed, in place, always. The cursor moves through them as characters; Backspace
  deletes one `*`; `![alt](url)` is editable text with a preview beside it that takes the same space either way.
  Typing a mark changes nothing around it, but for overtype: typing the closing mark that is already next steps over
  it (interact-markdown's `overtype`, its own extension, composed in).
- A reading surface (rendered messages, the wiki view) shows no marks. Both are drawn from the same syntax tree and
  styles; they differ only in the marks and in macro pill styling.
- Going from reading to editing is an explicit action (Edit, a key), or a gesture in the text: a click when the
  person turned on click to edit (`click_to_edit`), a double-click when it is off. Never focus. A click that
  something else handles (a link, a `<summary>`, a lore mark) starts no edit.
- A macro is one token: a pill showing its value, deleted whole by Backspace; `{{` opens suggestions. The reader shows
  the value without the pill styling. As the live editor's pills do now (`public/scripts/macro-pill.js`): a value only
  known when sent shows what the macro is, marked "Filled in when sent"; one that sends nothing is marked so; a person
  shows their name, with their card on hover.

## Commands

From `~/git/cyoa`'s design: every action is a command, reachable from the toolbar (each person chooses its buttons), a
bar beside the selection, right-click, the palette and keys. Each button's tooltip shows its key; holding Ctrl shows
every shortcut. With nothing selected, formatting buttons are switches for what's typed next and show pressed while
the cursor is in that style. On a touch screen the toolbar sits above the on-screen keyboard. The chat box is always
an editor, toolbar included, so the input used on every turn never reflows; other fields show their toolbar when
editing begins.

- Slash-command suggestions are the editor's own, the same mechanism as macro suggestions.
- Find and replace and its presets move over unchanged; their redesign is a separate item.
- Every editor's toolbar holds every formatting command by default, and find and replace where the editor has
  it.
- Open: which commands the bar beside the selection holds, and how a person chooses the toolbar's. Until that is
  decided the toolbar holds the commands a person's `editor_toolbar` setting lists; when it lists none, every
  formatting command and, where the editor has it, find and replace. There is no bar beside the
  selection, and every formatting command is also reachable by its key.

## Taken from cyoa, and what changes

Kept: decorations over the source text, link looks through `link(target)`, formatting state read from the syntax tree
(`src/client/editor/format.ts`), decorations moved rather than rebuilt while an IME composes.

Changed:
- Decorations cover the visible lines, not the whole text on every change.
- A text's links are worked out from its content, not reported as a side effect of drawing it.
- A general markdown core; each user adds drawing for its own syntax (names in looks, macros), instead of one switch.
- Inline HTML comes from the parser, not regexes.

## Stored text and the screen

Today the screen differs from the stored text at about 25 points (`messageFormatting`, `marked`, DOMPurify hooks,
lore marks, fade-in), and opening, saving and streaming rewrite the stored text in six places. With text as the
source of truth:

Nothing rewrites stored text to draw or edit it.
- The editor opens and saves the text exactly: no trimming, no greeting swap, no macros filled in. The prompt fills
  macros in messages (`src/prompt/chat-prompt.js`), so a macro stays a macro. `{{bias}}` stays in the text as a macro
  that sends nothing; the prompt reads it from there, not from `extra.bias`.
- Reasoning is split from a reply once, when it arrives, never on an edit.
- Streaming appends nothing; the incremental parse draws an unclosed mark as unclosed.

The screen shows the stored text.
- `display_text` and `reasoning_display_text` are not drawn. Only upstream extensions write them, and they aren't
  supported. They stay in stored messages as read.
- Hiding the reply prefix (`show_user_prompt_bias`) and the speaker name (`allow_name2_display`) goes: both hide text
  the model receives. `allow_name2_display` stays for what it also is: whether a reply keeps a leading `Name:` when
  it arrives.
- Every macro in every text is drawn as its value (Editing and reading), not only in the first message. A value is
  its scope's: the chat or card the text is in and the speaker it is from (none for the person), so `{{user}}` and
  `{{char}}` in a message are what the prompt fills in for it now. Where the chat is read up to is the latest when
  asked, not part of the scope.
- The page holds one set of values per scope (`public/scripts/macro-values.js`), and every view of a text draws from
  it: the rendered message, its editor, its reasoning and bias, the alternatives list and its editor, card field
  previews and editors, text boxes, the chat box. A value a view draws that the page doesn't hold is asked for, with
  the others asked in the same moment, and every text drawn in that scope is drawn again when it comes; so no view
  can show fewer values than another for the same text and scope.
- Answers carry values by scope, never in a message or by node (`macro_values`: `[{ speaker, values }]`, derived and
  never stored): opening a chat, alternatives, an edit, a stored reply and the message it answered, and the openings
  (`opening_macros`); the chat box's draft carries the person's (the draft's `macro_values`). Since no value waits for
  a node id, none is lost when an answer comes before the page knows the node it wrote.
- An action that may change every value (a settings change, a card field saved) lists every macro the page holds, by
  scope (`shownMessageMacros`), and is answered with their values now, which replace the page's; a scope the answer
  has none for is dropped, to be asked for again where it is drawn. A question asked before is answered into nothing.
  So a persona switch redraws every greeting, alternative, preview and text box, shown or not, without a request of
  its own.
- Opening a chat lists the macros the page holds for the person (`macro_sources`), which the texts drawn for the open
  chat rather than for one speaker draw (the chat box, text boxes, previews), and is answered with their values in
  that chat, so it stays one request.
- A macro in an HTML block's text is a macro (`public/scripts/chat-text/html-text.js`), drawn as its value inserted as
  text. HTML text uses the Markdown parser's same macro rule, with other Markdown syntax disabled; there is no
  separate macro scanner or hand-built macro tree. One in a tag's attribute is drawn as written.
- A value only known when sent (`{{random}}`, `{{roll}}`, `{{input}}`) is drawn as what it is; the prompt fills it in
  each time it is sent, as it fills the rest.
- Passes that exist only because HTML is edited as a string go: `align*` to `$$`, `&amp;` in code, removing every
  U+200B, U+FFFE as a quote, trimming the result.

Drawing is syntax in the one grammar and table, not passes over HTML: dialogue quotes, a single newline as a line
break, emoji shortcodes, image sizes (on an image or its reference definition), lines kept out of markdown
(`markdown_escape_strings`), reasoning markers in a body drawn as text, inside HTML blocks too. Inline HTML is a node
with one policy: drawn or shown as text (`encode_tags`), classes prefixed, styles scoped to messages, external media,
links opening a new tab, autoplay; inline SVG is drawn under the same policy.

Overlays are ranges over the source text, drawn the way the editor draws decorations: lore marks (activation reports
ranges in the text it read, so nothing is rendered twice), search matches, code highlighting, fade-in of streamed text.
An overlay is asked with the text and its syntax tree, which code highlighting needs to find each block's language.

Every surface that shows a message (the chat, streaming, the Alternatives list, the bias line, an edit's Done and
Cancel) draws through the reader, and so does every other place that drew markdown: card field previews, the creator's
notes, a person's card, slash command output and the live editor's previews. `marked`, `messageFormatting` and the live
editor's fragment rendering are replaced, not kept beside it. The app's own messages (help, the welcome screen: system
messages from SillyTavern System) are the page's HTML, not chat text, and are shown as such.

## Where it lives

The core goes in interact: text as truth, drawing from a lossless syntax tree with the grammar passed in, dimmed marks
and the reader, commands, and extension points. An app's own syntax (macros, slash commands) and how its text is synced
are extensions and ports, kept in the app. The design of the core is interact's `docs/design.md`, Editor.

The reader is a walk over the syntax tree into DOM elements. One table maps each syntax node to its element and
classes, and both the editor's decorations and the reader use it.
