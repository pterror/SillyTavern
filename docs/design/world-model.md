# The world model

The structure of a world: for putting it down, reading it and editing it together. It knows nothing about prompts.
ST's prompt is one consumer of worlds, defined in `prompt-model.md`, which reads them (In the prompt, below). This
replaces the parts of `worldbuilding.md` that say otherwise, as listed at the end. Each part says what it is checked
against; what isn't checked yet is under Unverified.

## Stored and derived

```ts
World  = Change[]                        // the only source of truth, append-only
Change = { id, parents: ChangeId[], author, at, ops: Op[] }
Op     = Create(e) | Delete(e) | Set(e, field, Value) | EditText(e, field, TextOp)

Entry  = { id, fields: Map<Field, Value> }   // id is stable across renames and moves
Value  = Text | Number | Bool | Ref(EntryId) | List<Value> | Condition | Placement
```

Everything else is derived from the changes and never written by hand: the current state, the index (names to
entries, mentions, what refers to an entry, entries not written yet), and every view. Derived data may be stored as an
index, but is never a second source of truth.

- Checked against: one source of truth; collaboration "architecturally supported, not necessarily everything all at
  once" (owner, intent board). Attributed changes with stable ids are what versions, proposals and forks need; live
  editing is many authors appending to one version. Building those comes later; nothing in the model has to change
  for them.

## Entries

Everything authored is an entry: places, people, rules, history, and also characters, personas, groups and worlds.

Fields are open: any entry can have any field. A kind is a set of fields used together, for authoring and reading
convenience (owner, m8), never a type an entry must have. A character is an entry with the card's fields
(description, personality, scenario, greetings, examples, ...). What a field means is up to whoever reads it: the
world stores and cascades it, and the prompt reads the fields it knows (In the prompt).

A new entry exists at once, blank; nothing waits for it to be filled in (owner, on new characters).

## Names and triggers

An entry's **keys** are the words that stand for it. A key is either a **name** or a **trigger**:

- A **name** is a key whose occurrence in text means a reference to the entry. So a name is drawn in the entry's look,
  linked, found by search, and its occurrences are the entry's mentions.
- A **trigger** is a word associated with the entry without being a reference to it: "blood" is associated with an
  entry on vampires without every "blood" in every text being a reference to it.

Both are matched by the same keyword predicate; they differ only in whether an occurrence is a reference. This is why
both exist (owner, m19).

Links are names found in the text, not markup written into it, so the text is exactly what was written and any reader
of it (a person, the wiki, the prompt) gets it unchanged (`editor.md`, Model). A name shared by several entries is a
reference to each; the reader shows the choice rather than picking one.

## Relations and groups

A relation is a field whose value is a `Ref`, named by its field ("in", "works at"). Relations are optional (owner,
m5): a world with none is a list of entries. Mentions and what refers to an entry are derived from the index, so
they're never core (owner, m6).

Being **in** an entry is the one structural relation: groups, worlds and a character's own lore are entries that others
are in. An entry can be in several, in an order it keeps (a fractional position, as `worldbuilding.md` stores
relations).

A pick-one group (upstream's inclusion group) is an entry with a selection rule (keep one of its active members, by
weight or by score), not a separate book-level mechanism.

## The cascade

```ts
resolve(e, field) = e.fields[field] ?? first(parents(e), p => resolve(p, field)) ?? theme[field]
```

`parents(e)` are the entries it's in, in its own order; a world is one of them. That one rule covers looks
(theme → world → group → shared look → entry, `looks.md`) and every other field, including the ones only the prompt
reads. Where a value comes from is part of the answer, so the page can always say which parent set it.

Settings levels (default, preset, user, group, character; `settings-scopes.md`) are the same rule over levels.

- Checked against: settings "ergonomic for all cases: one entry, many entries, the whole world" (owner, m16). Setting
  a value on a group or world sets it for every member that doesn't state its own; setting it on many entries is a
  bulk write of the same field.

## Predicates and views

A predicate selects entries: a field compared with a value, keywords found in a text, **related** (related by a given
field to an entry in a set, one step or any number), combined with all / any / not. A predicate reads a context; the
world's own context is its state. A consumer can add to the context and to the predicates that read it; the prompt
does (In the prompt). Owner, on conditions and view filters: "if they are different things at all it's worrying."

```ts
View = { filter: Predicate, draw: Wiki | Overview | Board | Table, shows: Field[] }
```

What a card or row shows is the view's choice (`shows`): cards for recognising entries, rows for comparing them.

## In the prompt

The prompt is a consumer of worlds; this section is how `prompt-model.md` reads them, not part of the world.

- A prompt entry (content, role, placement, condition) is a world entry read through the fields the prompt knows;
  each is `resolve`d, so a group or world can set placement or a condition for all its members.
- The prompt's conditions (generation type, who, every n / from n, sticky and cooldown, chance, variables) are
  predicates over a context that adds the chat: `{ state, chat, activations, generation }`, activations being earlier
  turns, for sticky and cooldown. A view's filter is the same form with no chat, so a condition needing one is false
  there.
- The card provider reads a character entry's card fields.

Activation:

```ts
active(chat) = select(budget, fix(S => S ∪ { e | eval(resolve(e, "when"), e, { ...ctx, scanned: chat + text(S) }) }))
```

- Re-scanning added text and following relations are both steps of the one fixpoint; there is no numeric recursion
  limit. It ends because the set only grows over finitely many entries.
- For the set to only grow, `not` may not apply to anything that reads the growing set (keywords looking in active
  entries, related). Such a condition is refused when it's written, so every condition evaluates.
- Chance is seeded per entry and turn, so the same chat always gives the same result.
- `select` keeps entries in priority order while the budget lasts, and applies pick-one groups. An entry that came up
  only through entries the budget cut is cut too. What's cut is shown, with why.
- Placement is the prompt model's: a position in a parent, with layouts declaring the named sections.

The test area is `active` over a chat typed into it and kept; the marks in chat are `active` recorded for each reply,
on every visible reply. Both show why each entry came up, or didn't.

A chat activates from its worlds, the persona and every member; a chat with one character is a group of one.

## Sharing

```ts
export(selection) = closure(selection, Ref) -> Card | Lorebook | World
```

Sharing is choosing entries; everything they're in or refer to comes with them. A card is one character entry and its
closure; a lorebook is a world's entries; a world file carries any selection, characters included. Import is the
inverse. Upstream formats are written where they can say it; what they can't is listed as lost, never dropped
silently (`prompt-model.md`, What this replaced).

## Unverified

- Characters as entries at 10 billion cards with no cost per card: the library engine's store and this model's must
  be one store, or characters are entries in name only.
- The current worldbuilding store (`worldbuilding-store.md`) keeps upstream's book JSON with relations in extension
  data. A change log per entry (as cyoa keeps one document per page) is the history this model needs. How the two
  meet, and the cost of reading state, is not worked out.
- The budget's "cut what came up only through a cut entry" needs an algorithm; with priorities it isn't a single pass.
- Name matching over large worlds: one automaton per world, linear in the text. Not measured against the current
  index.

## Changes to other documents

- `worldbuilding.md`: inclusion groups are entries in this model; "a world is a lorebook" holds for import and export,
  not for storage.
- `prompt-model.md`: groups stop being a book-level rule; the card provider reads the character entry.
