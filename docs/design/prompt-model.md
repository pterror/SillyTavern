# The prompt model

What's sent to a model, as one structure for every API: a tree of sections, each placed by a parent and a position in it, filled by entries
that say when they're active. Replaces the chat completion prompt manager, Advanced Formatting's templates and System
Prompt, the utility prompts, the Author's Note and character's note, lorebook positions and the injection table, and
the fixed positions in `extension_prompt_types`, `world_info_position` and `persona_description_positions`. See
`settings-reorganization.md` for why.

The server builds every prompt this way (`src/prompt/`). Until the screen for editing the tree exists, the layout and
books are made for each request from the settings people have today, as described below.

## Sections

The prompt is a tree of **sections**. Each has exactly one parent and a position among its siblings. A section has:
- an **id** (stable; what placements refer to) and a display name;
- **content**: its own text (macros resolved when the section is made) and its children. Its own text has a position
  among its children: after those placed `first in` it, before those placed `last in` it and the rest. A section's
  text may reference an outlet (`{{outlet::name}}`); any reference, in any section's text, declares that outlet as a
  child placed there, and what's placed in the outlet fills it;
- a **role** (system, user, assistant), or none to take its parent's, and for a message who speaks it;
- **budget**: kept whole, dropped whole, or trimmed (dropping children from its oldest end: history's first, examples'
  last) when the prompt is over the context; and its priority among what's dropped.

A section can also join the pieces it holds with a separator (the note, lore, the messages joined at one depth), and
a template can stand in for its text over its children (the story string, World Info format).

The core knows sections, placement, entries and **providers**, and no section names. A provider makes sections from
the generation's state; providers are registered in a server-side registry (`registerProvider`, `src/prompt/model.js`)
and declare what they produce:
- history: one child per message (role from who wrote it), oldest first; a message with tool calls is one child
  holding the call and its results;
- examples: one child per example dialogue block;
- the card: `description`, `personality`, `scenario`;
- the persona: its description.

The card's system prompt and after-history instructions override the preset's entries for them (`{{original}}` is the
preset's text), as Prefer Char. Prompt / Instructions say.

A layout's names (`lore-before`, `note`, an outlet) are data: sections declared empty, to be filled.

## Placement: a position in a parent

Every section, a layout's own included, is placed by a parent and a position in it. A layout is a book of always-on
sections; the editor shows siblings as a list, and dragging one writes its position.

| Position | Means |
|---|---|
| `first in x` / `last in x` | x's first or last children: before x's own text, or after it |
| `before y` / `after y` | in y's parent, next to y (resolved to a sort key beside y's) |
| `in x, n from the end` / `n from the start` | among the children x's provider made, with n of them after it (or before it); other placed sections don't count. Past the start it goes first, a larger n earlier |
| `in x, n from the end of what's rendered` | with n of everything rendered in x after it, counted once the budget has settled what's in |
| `order` | the sort key among siblings at the same position, then id |

- What should move with a section goes inside it, as a child: siblings never depend on each other.
- A section whose parent isn't in this prompt (an inactive entry, a provider with nothing in it) isn't placed. It can
  name a **fallback** parent; otherwise the preview says why it's missing.
- Placements must not loop. Edits that would make one are refused, so a prompt always builds.

Upstream's lore positions, and extensions' prompts, are each one case:

| Upstream | In the model |
|---|---|
| ↑Char / ↓Char | last in `lore-before` / `lore-after`, which the story string has at `{{wiBefore}}` / `{{wiAfter}}` and the prompt manager at its World Info markers |
| ↑AN / ↓AN | first in / last in `note`, so before and after the note's own text |
| ↑EM / ↓EM | first in / last in `examples` |
| @D n with a role | in history, n from the end, with that role |
| outlet `name` | last in `name` |
| `order` | the sort key (ascending where upstream lists lower orders first, descending for ↑EM and outlets, which upstream lists highest first), and the priority when the lore budget is short |
| `setExtensionPrompt` IN_CHAT / BEFORE_PROMPT / IN_PROMPT / NONE | entries in an extensions book: by depth and role / at the layout's matching places (the story string's anchors; before and after the prompt manager's Main Prompt) / scanned for lore, never placed |

Upstream joins all @D entries with the same depth and role into one message, so the import wraps them in one section
per depth and role that joins its children, each trimmed, ordered by their upstream key; the prompt manager also keeps
apart prompts at one depth with different injection orders, so for chat completion the wrapper is per depth, order
and role. Depth counts only messages, as the position above does. Where upstream counts differently, the import
places the entry to send what upstream sends: on continue, text completion puts depth 0 one message up, and chat
completion counts the message being continued, which goes to the end. The CFG positive prompt is placed n from the end
of what's rendered in history, as upstream counts it. Export back gives an entry its upstream position where it has
one; any other is listed as lost, not dropped silently.

## Entries and books

An **entry** is a section that isn't always there: content, role, placement, and a **condition** for when it's
active. A **book** is a list of entries. Books are attached at levels (chat, character, user, as with every setting:
a chat's book is its own, the character's is the card's), and a prompt preset names books too.

- The system prompt is an entry in the preset's book: `first in prompt` by default, always; an imported story string
  or prompt order places it where it has it.
- The Author's Note is an entry in the chat's book: `in history, 4 from the end`, every 1 message. It is the `note`
  section: its own text with ↑AN lore before it and ↓AN lore after, joined by line; its condition (sent this turn)
  covers the whole section, children included, and with nothing in it the note isn't sent. A chat can have several.
  The character's note is the same in the card's book, and wraps the chat's note before, after or in place of it as
  its setting says; the persona's top / bottom of note positions are first / last in the note. "Default note for new
  chats" is an entry in the user's book, inherited by every chat that doesn't state its own (not copied in).
- Lore entries are entries with a keyword condition.
- Utility prompts are entries with a generation-type condition: impersonation's is active on impersonate, the
  continue nudge on continue, the group nudge in groups.
- The instruct alignment message is an entry first in history, active when the chat part doesn't start with a user
  message; like every condition it's settled before the budget.

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

The core evaluates always, generation type and all / any / not; the others are evaluated by their own evaluators
(world info scanning for keywords, sticky, cooldown, chance and groups; the note's interval) and reach the core as
their outcome.

**Groups** stay as a book-level rule: of the active entries in a group, keep one (by weight, or by scoring), as
inclusion groups do. An always-active entry shows none of the condition editor (WI4).

## Layouts and rendering

A **layout** is the root's skeleton: which sections exist and where (e.g. system prompt, card, persona, examples,
lore, history, after-history), with their roles and budgets. It's data, and a prompt preset is a layout plus books.

The request format renders the same tree:
- **chat** (message list): each section with a role becomes a message of its descendants' text; a message with no
  text isn't sent; a section can say it joins its neighbour instead (squash: consecutive system messages without a
  name, the chat and example separators and the group nudge excepted);
- **text** (one prompt string): each section's text in order; each message is formatted as its role's (with an
  instruct template, wrapped in its role's sequences; without one, `name: text` on its own line), with the first /
  last variants for the first message, the last user message (not when impersonating) and the message the reply
  continues, which is left open. A text section can say it joins the previous one instead of standing on its own:
  the previous one first loses one trailing newline when the join says so, then a newline goes between them unless
  the previous one already ends with one, or a space unless it ends with whitespace, as the join says. The reply's
  start, the quiet prompt, the bias and a depth-0 CFG prompt join the last chat item this way. The story string is a
  layout section whose template references its children, so it survives as a text template.

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
   overhead for chat), by the connection's tokenizer: what's kept as one text (text) or its messages (chat), each
   droppable section on its own. Chat counts squashed messages as the messages they were.
2. Kept sections are counted first. If they alone exceed the budget, the request is refused, naming the largest
   sections and their sizes; a prompt is never sent over the context.
3. What can be dropped fills what's left in one declared order, by priority: a dropped-whole section by its own (chat
   completion's reply to an empty turn goes before history), history whole messages newest first, examples whole
   blocks after history (before it when pinned). A trimmed section stops at its first child that doesn't fit. Entries
   placed inside history count as kept, and so does the message being continued.
4. A section fits when the total stays at or under the budget.

Text completion used to fit on a strict `<`, count the examples apart from history, and send an over-budget prompt
with its history emptied; chat completion fit on `≤`, threw, and dropped entries placed in history with it. The rule
above replaced both.

## Parameters by name

Generation parameters are stored as `{ parameter: value }`, where the parameter is its own id (`temperature`,
`top_p`, `presence_penalty`). What the app knows about one (label, tip, range, step, default) is a table looked up by
that id, as data. Each backend's adapter lists the parameters it takes and their wire names.
Adapters don't use the Vercel AI SDK: "no vercel ai sdk and just do things properly for fuck's sake" (owner,
2026-09-14T17:30:02). A temperature exists
once, whatever the backend; the panel shows what the current connection takes. Parameters a backend takes but the
table doesn't know can be added per connection as `{ wire name: value }`.

## What this replaced, and what to check

- Server: one builder (`src/prompt/model.js`: resolve active entries, place them, apply the budget, render; the
  text and chat layouts in `src/prompt/text-prompt.js` and `src/prompt/chat-prompt.js`; upstream-positioned entries in
  `src/prompt/injections.js`) instead of `assembleTextCompletionPrompt`, `prepareOpenAIMessages` (with
  `preparePromptsForChatCompletion` and `populateChatCompletion`) and the injection table. No test pins upstream's
  output.
- Import: upstream presets, templates, lorebooks and notes convert into layouts, books and entries; export goes back
  to upstream's formats (lossy where upstream can't say it, listed).
- To check while building: where lore scanning reads injected text from (the page scans extension prompts, the server
  only the note and quiet prompt); which backends report a chat template, and how.
