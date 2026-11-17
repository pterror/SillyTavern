# Worldbuilding requests

The worldbuilding screen separates navigation, viewport updates, and stored edits.
The schemas in `packages/areas/worldbuilding/protocol.ts` validate every request on
its way to the server. The client and legacy-page bridge share `NavigationTarget`,
inferred from that schema.

## Navigation

`worldbuilding.navigate` always has the same envelope:

```ts
{
    to: { kind: 'character', character: '42' },
    overview: { layout, ahead: 100 },
    pointingAt: { layout, endRank: 12 },
}
```

Only `to` changes with the destination:

- `world`: select a book by ID, or the last/default book when `book` is null;
  optionally choose its grouping and an occurrence to include.
- `named`: resolve a legacy world name and optional entry UID.
- `at`: resolve a book ID and optional entry ID.
- `character`: open the character's embedded book.
- `entry`: open an entry in the current book.
- `back`: return from the entry to its overview.

The page supplies the read parameters in one place. The bridge queues the same
destination shape to a page mounted while the drawer stays closed. It reveals
the drawer only after successful navigation has applied the requested views, so
the previous book is never exposed during opening. It does not translate the
destination into a different set of navigation commands. Imports remain upload
operations.

## Viewport

`worldbuilding.setViewport` accepts only `{ layout, ahead }`. Both resizing and
loading more entries use it. It changes the current session's overview layout
and extends its read range, retaining entries already loaded. Repeated requests
with the same layout and no larger range do nothing.

A viewport request contains no book or destination. It cannot call `openWorld`,
resolve a character, select a saved view, or clear an open entry, filter, selection,
or last-change state. A delayed update applies to the currently shown overview;
when no world is open it does nothing. Its invalidation belongs to that session.

## Stored edits

Entry, relation, world, and saved-view edits remain explicit commands with their
own validation and conflict rules. They are not navigation or viewport variants.
When adding a UI operation, use navigation for a destination change, viewport for
read geometry/range, and an edit for stored data. Do not reuse navigation merely
to reload data.
