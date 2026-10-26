# The prompt model

What's sent to a model, as one structure for every API: sections placed relative to each other, filled by entries
that say when they're active. Replaces the chat completion prompt manager, Advanced Formatting's templates and System
Prompt, the utility prompts, the Author's Note and character's note, lorebook positions and the injection table
(`src/prompt-injections.js`), and the fixed positions in `extension_prompt_types`, `world_info_position` and
`persona_description_positions`. See `settings-reorganization.md` for why.

## Sections

The prompt is a tree of **sections**. A section has:
- a **name** (unique in the prompt; what others anchor to);
- **content**: text with macros, which may reference its children by name (`{{outlet::name}}`) to place them inside
  its text; children it doesn't reference follow its text, in order;
- a **role** (system, user, assistant), or none to take its parent's;
- **budget**: whether it's kept whole, dropped whole, or trimmed (from its oldest child) when the prompt is over the
  context; and its priority among what's dropped.

Some sections come from the chat, not from entries: **sources**. Each is a section with generated children:
- `history`: one child per message in the chat (role from who wrote it), oldest first;
- `examples`: one child per example dialogue block;
- `card` with children `description`, `personality`, `scenario`, `system`, `after-history` (the card's fields);
- `persona`: the active persona's description;
- `notes` and other names a layout or book declares empty, to be filled (**outlets**).

## Placement: relative to another section

Every entry, and every section a layout declares, is placed relative to an **anchor** section:

| Relation | Means |
|---|---|
| `before x` / `after x` | as x's sibling, just before or after it |
| `first in x` / `last in x` | as x's first or last child |
| `in x, n from the end` / `n from the start` | among x's children, with n of them after it (or before it) |

- "Depth n in the chat" is `in history, n from the end`. "Top / bottom of the Author's Note" is
  `first in note` / `last in note`. "Before / after the character" is `before card` / `after card`. A lorebook outlet
  is `last in <outlet>`.
- Anything can be an anchor, entries included: "after my style guide entry", "first in the persona".
- Several things in the same place go by **order** (a number), then by name.
- An entry whose anchor isn't in this prompt (inactive, or a source with nothing in it) isn't placed. It can name a
  **fallback** anchor to use instead.
- Placements must not loop (A after B after A). Edits that would make a loop are refused, so a prompt always builds.

## Entries and books

An **entry** is a section that isn't always there: content, role, placement, and a **condition** for when it's
active. A **book** is a list of entries. Books are attached at levels (chat, character, user, as with every setting:
a chat's book is its own, the character's is the card's), and a prompt preset names books too.

- The system prompt is an entry in the preset's book: `first in prompt`, always.
- The Author's Note is an entry in the chat's book: `in history, 4 from the end`, every 1 message. A chat can have
  several. The character's note is the same in the card's book. "Default note for new chats" is an entry in the
  user's book, inherited by every chat that doesn't state its own (not copied in).
- Lore entries are entries with a keyword condition.
- Utility prompts are entries with a generation-type condition: impersonation's is active on impersonate, the
  continue nudge on continue, the group nudge in groups.

## Conditions

One condition per entry, made of these, combined with all / any / not:

| Condition | Replaces |
|---|---|
| always | constant entries, every preset prompt |
| keywords (list; where to look: the last n messages, the card, the persona, other active entries; whole words; case) | primary/secondary keys and their logic, scan depth, match-whole-words, case-sensitive, "match character description" etc., recursion and its flags |
| generation type (normal, continue, impersonate, swipe, quiet) | triggers, the utility prompts' fixed uses |
| who (character, tags, persona) | character filter |
| every n messages / from message n | the Author's Note interval, delay |
| for n messages after it's active / not within n after | sticky, cooldown |
| chance p | probability |
| a variable or chat state | (new: the backlog's conditional entries, WI1) |

**Groups** stay as a book-level rule: of the active entries in a group, keep one (by weight, or by scoring), as
inclusion groups do. An always-active entry shows none of the condition editor (WI4).

## Layouts and rendering

A **layout** is the root's skeleton: which sections exist and where (e.g. system prompt, card, persona, examples,
lore, history, after-history), with their roles and budgets. It's data, and a prompt preset is a layout plus books.

The request format renders the same tree:
- **chat** (message list): each section with a role becomes a message; a section can say it joins its neighbour
  instead (squash);
- **text** (one prompt string): each section's text in order; with an instruct template, each message is wrapped in
  its role's sequences (first/last variants as now). The story string is a layout section whose content references
  its children (`{{outlet::card}}` …), so it survives as a text template.

So one prompt preset works over both formats, and choosing a backend never switches prompt systems.

Format templates ("[Scenario: {0}]", World Info format) are a section's content wrapping its children.

## Parameters by name

Generation parameters are stored as `{ parameter: value }`, where the parameter is its own id (`temperature`,
`top_p`, `presence_penalty`). What the app knows about one (label, tip, range, step, default) is a table looked up by
that id, as data. Each backend's adapter lists the parameters it takes and their wire names. A temperature exists
once, whatever the backend; the panel shows what the current connection takes. Parameters a backend takes but the
table doesn't know can be added per connection as `{ wire name: value }`.

## What this replaces, and what to check

- Server: one builder instead of `assembleTextCompletionPrompt` and `prepareOpenAIMessages` (with
  `preparePromptsForChatCompletion` and `populateChatCompletion`) and the injection table: resolve active entries,
  place them, apply the budget, render. Prompt parity tests (`tests/frontend/PromptParity.e2e.js`) pin today's
  output for imported presets.
- Import: upstream presets, templates, lorebooks and notes convert into layouts, books and entries; export goes back
  to upstream's formats (lossy where upstream can't say it, listed).
- To check while building: the budget order today (chat completion keeps prompts, then fills examples and history;
  text completion trims history and examples against the story string), so the defaults keep today's output; token
  counting per section for the budget; where lore scanning reads injected text from (today the page scans extension
  prompts, the server only the note and quiet prompt).
