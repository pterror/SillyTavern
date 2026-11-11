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
  Typing a mark changes nothing around it.
- A reading surface (rendered messages, the wiki view) shows no marks. Both are drawn from the same syntax tree and
  styles; they differ only in the marks and in macro pill styling.
- Going from reading to editing is an explicit action (Edit, a key), never focus or a click into the text.
- A macro is one token: a pill showing its value, deleted whole by Backspace; `{{` opens suggestions. The reader shows
  the value without the pill styling.

## Commands

From `~/git/cyoa`'s design: every action is a command, reachable from the toolbar (each person chooses its buttons), a
bar beside the selection, right-click, the palette and keys. Each button's tooltip shows its key; holding Ctrl shows
every shortcut. With nothing selected, formatting buttons are switches for what's typed next and show pressed while
the cursor is in that style. On a touch screen the toolbar sits above the on-screen keyboard. Toolbar placement in each
field is reserved space, so it never moves the field.

- Slash-command suggestions are the editor's own, the same mechanism as macro suggestions.
- Find and replace and its presets move over unchanged; their redesign is a separate item.

## Taken from cyoa, and what changes

Kept: decorations over the source text, link looks through `link(target)`, formatting state read from the syntax tree
(`src/client/editor/format.ts`), decorations moved rather than rebuilt while an IME composes.

Changed:
- Decorations cover the visible lines, not the whole text on every change.
- A text's links are worked out from its content, not reported as a side effect of drawing it.
- A general markdown core; each user adds drawing for its own syntax (names in looks, macros), instead of one switch.
- Inline HTML comes from the parser, not regexes.

## Open

- Where the shared package lives (interact or its own repository).
- Whether rendered messages can be drawn from the same syntax tree without an editor per message, at long-chat sizes.
- What the live editor's macro pills show today.
