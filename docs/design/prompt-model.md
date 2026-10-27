# The prompt model

What's sent to a model, as one structure for every API: a tree of sections, each placed by a parent and a position in it, filled by entries
that say when they're active. Replaces the chat completion prompt manager, Advanced Formatting's templates and System
Prompt, the utility prompts, the Author's Note and character's note, lorebook positions and the injection table
(`src/prompt-injections.js`), and the fixed positions in `extension_prompt_types`, `world_info_position` and
`persona_description_positions`. See `settings-reorganization.md` for why.

## Sections

The prompt is a tree of **sections**. Each has exactly one parent and a position among its siblings. A section has:
- an **id** (stable; what placements refer to) and a display name;
- **content**: text with macros, which may reference its children by name (`{{outlet::name}}`) to place them inside
  its text; children it doesn't reference follow its text, in order;
- a **role** (system, user, assistant), or none to take its parent's;
- **budget**: kept whole, dropped whole, or trimmed (from its oldest child) when the prompt is over the context; and
  its priority among what's dropped.

The core knows sections, placement, entries and **providers**, and no section names. A provider makes sections from
the chat, registered the same way an extension registers one, and declares what it produces:
- history: one child per message (role from who wrote it), oldest first;
- examples: one child per example dialogue block;
- the card: `description`, `personality`, `scenario`, `system`, `after-history`;
- the persona: its description.

A layout's names (`lore-before`, `note`, an outlet) are data: sections declared empty, to be filled.

## Placement: a position in a parent

Every section, a layout's own included, is placed by a parent and a position in it. A layout is a book of always-on
sections; the editor shows siblings as a list, and dragging one writes its position.

| Position | Means |
|---|---|
| `first in x` / `last in x` | x's first or last child |
| `before y` / `after y` | in y's parent, next to y (resolved to a sort key beside y's) |
| `in x, n from the end` / `n from the start` | among the children x's provider made, with n of them after it (or before it); other placed sections don't count |
| `order` | the sort key among siblings at the same position, then id |

- What should move with a section goes inside it, as a child: siblings never depend on each other.
- A section whose parent isn't in this prompt (an inactive entry, a provider with nothing in it) isn't placed. It can
  name a **fallback** parent; otherwise the preview says why it's missing.
- Placements must not loop. Edits that would make one are refused, so a prompt always builds.

Upstream's lore positions, and extensions' prompts, are each one case:

| Upstream | In the model |
|---|---|
| ↑Char / ↓Char | last in `lore-before` / `lore-after`, which the default layout puts where the story string has `{{wiBefore}}` / `{{wiAfter}}` and the prompt manager its World Info markers |
| ↑AN / ↓AN | first in / last in `note`; not placed when the note isn't sent this turn, as today |
| ↑EM / ↓EM | first in / last in `examples` |
| @D n with a role | in history, n from the end, with that role |
| outlet `name` | last in `name` |
| `order` | the sort key, and the priority when the lore budget is short |
| `setExtensionPrompt` IN_CHAT / BEFORE_PROMPT / IN_PROMPT / NONE | entries in an extensions book: by depth and role / at the layout's matching places / scanned for lore, never placed |

Two details the import keeps exactly: upstream joins all @D entries with the same depth and role into one message, so
the import wraps them in one section per depth and role that joins its children; and depth counts only messages, as
the position above does. Export back gives an entry its upstream position where it has one; any other is listed as
lost, not dropped silently.

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

**The instruct template is a fact of the model**, worked out at connect time from the model's own chat template (the
Jinja `chat_template` the backend reports, else the model repo's `tokenizer_config.json`): a fixed probe conversation
is rendered through it and through each known instruct template, and the one with identical output is used; when
none matches, the role prefixes and suffixes are read off the probe's output. A connection can pin a template
instead. This replaces the activation regex, the template-hash table (`public/scripts/chat-templates.js`), Bind Model
to Templates and the derive bolts.

## Budget

One rule for every format, applied to the tree before rendering:
1. Each section is counted as it will be sent (wrapped in its role's sequences for text, with the per-message
   overhead for chat), by the connection's tokenizer.
2. Kept sections are counted first. If they alone exceed the budget, the request is refused, naming the sections and
   their sizes; a prompt is never sent over the context.
3. Trimmed sources fill what's left in one declared order: history whole messages newest first, examples whole
   blocks after history (before it when pinned). Entries placed inside history count as kept.
4. A section fits when the total stays at or under the budget.

Today's builders follow the same order but differ at the edges: text completion fits on a strict `<`
(`src/chat-history-budget.js`), counts strings without their wrapping, and sends an over-budget prompt with its
history emptied; chat completion fits on `≤` and throws. Both are replaced by the rule above.

## Parameters by name

Generation parameters are stored as `{ parameter: value }`, where the parameter is its own id (`temperature`,
`top_p`, `presence_penalty`). What the app knows about one (label, tip, range, step, default) is a table looked up by
that id, as data. Each backend's adapter lists the parameters it takes and their wire names. A temperature exists
once, whatever the backend; the panel shows what the current connection takes. Parameters a backend takes but the
table doesn't know can be added per connection as `{ wire name: value }`.

## What this replaces, and what to check

- Server: one builder instead of `assembleTextCompletionPrompt` and `prepareOpenAIMessages` (with
  `preparePromptsForChatCompletion` and `populateChatCompletion`) and the injection table: resolve active entries,
  place them, apply the budget, render. Prompt parity tests (`tests/frontend/PromptParity.e2e.js`) pin upstream's
  output for imported presets where the prompt fits the budget; over the budget the rule above is tested on its own,
  and the differences from upstream are listed in `tests/frontend/prompt-parity-known.js`.
- Import: upstream presets, templates, lorebooks and notes convert into layouts, books and entries; export goes back
  to upstream's formats (lossy where upstream can't say it, listed).
- To check while building: where lore scanning reads injected text from (today the page scans extension prompts,
  the server only the note and quiet prompt); which backends report a chat template, and how.
