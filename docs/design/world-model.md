# The world model

The structure of a world, for putting it down, reading it, and understanding and editing it together. It knows nothing
about prompts, chats, cards or lorebooks: those are how SillyTavern reads and shares worlds (`prompt-model.md`,
Reading worlds). Each part says what it is checked against; what isn't checked yet is under Unverified.

## Stored and derived

```ts
World  = Change[]                        // the only source of truth, append-only
Change = { id, parents: ChangeId[], author, at, ops: Op[] }
Op     = Create(e) | Delete(e) | Set(e, field, Value) | EditText(e, field, TextOp)

Entry  = { id, fields: Map<Field, Value> }   // id is stable across renames and moves
Value  = Text | Number | Bool | File(hash) | Ref(EntryId) | List<Value> | Predicate
```

Everything else is derived from the changes and never written by hand: the current state, the index (names to
entries, mentions, what refers to an entry, names nothing has yet), and every view. Derived data may be stored as an
index, but is never a second source of truth.

- Checked against: one source of truth; collaboration "architecturally supported, not necessarily everything all at
  once" (owner, intent board). Attributed changes with stable ids are what versions, proposals and forks need; live
  editing is many authors appending to one version. Building those comes later; nothing in the model has to change
  for them.

## Entries

Everything in a world is an entry, whatever it is: a place, a person, an event, a rule, a group, the world itself.

Fields are open: any entry can have any field, and what a field means is up to whoever reads it. A kind is a set of
fields used together, for authoring and reading convenience (owner, m8), never a type an entry must have.

A new entry exists at once, blank; nothing waits for it to be filled in.

## Names

A **name** is how an entry is referred to: an occurrence of it in text is a reference to the entry. So a name is drawn
in the entry's look, linked, found by search, and its occurrences are the entry's mentions.

Links are names found in the text, not markup written into it, so the text is exactly what was written and every
reader of it gets it unchanged (`editor.md`, Model). A name shared by several entries is a reference to each; the
reader shows the choice rather than picking one.

## Relations

A relation is a field whose value is a `Ref`, named by its field ("in", "works at"). Relations are optional (owner,
m5): a world with none is a set of entries. Mentions and what refers to an entry are derived from the index, so
they're never core (owner, m6).

Being **in** an entry is the one structural relation: a group, a region, the world are entries others are in. An entry
can be in several, and each keeps the order of what is in it (an ordered list, `ordered-lists.md`).

## The cascade

```ts
resolve(e, field) = e.fields[field] ?? first(parents(e), p => resolve(p, field)) ?? defaults[field]
```

`parents(e)` are the entries it's in, in its own order. That one rule covers looks (`looks.md`) and every other field.
Where a value comes from is part of the answer, so the page can always say which entry set it.

- Checked against: settings "ergonomic for all cases: one entry, many entries, the whole world" (owner, m16). Setting
  a value on a group or the world sets it for every member that doesn't state its own; setting it on many entries is
  a bulk write of the same field.

## Predicates and views

A predicate selects entries: a field compared with a value, words found in a text, **related** (related by a given
field to an entry in a set, one step or any number), combined with all / any / not. A predicate reads a context; the
world's own context is its state. A reader of worlds can add to the context and the predicates that read it.

```ts
View = { filter: Predicate, draw: Wiki | Overview | Board | Table, shows: Field[] }
```

What a card or row shows is the view's choice (`shows`): cards for recognising entries, rows for comparing them.

## Sharing

```ts
export(selection) = closure(selection, Ref)
```

Sharing is choosing entries; everything they're in or refer to comes with them. Import is the inverse. Formats are
the reader's business: a format that can't say something lists it as lost, never drops it silently.

## Unverified

- The current worldbuilding store (`worldbuilding-store.md`) keeps upstream's book JSON with relations in extension
  data. A change log per entry (as cyoa keeps one document per page) is the history this model needs. How the two
  meet, and the cost of reading state, is not worked out.
- Name matching over large worlds: one automaton per world, linear in the text. Not measured against the current
  index.

## Changes to other documents

- `worldbuilding.md`: "a world is a lorebook" holds for import and export, not for storage; triggers are the
  prompt's (`prompt-model.md`, Reading worlds).
