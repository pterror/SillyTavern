# Decoupling boot from full character residency

This doc was a design pass on one gap: boot waited on the whole character library before the app
was usable. Its options (render first and fill the library in the background, or keep the chunked
fetch and stop awaiting it) are moot: the page no longer holds the library at all. What follows is
what boot does now, for the next reader.

## What boot does

`firstLoadInit()` (`public/script.js`):

1. `getSettings()` reads `/api/settings/get`. Its answer carries `libraryChangesSeq`, the end of the
   server's change log at that moment, and `startLibraryChangesAt()` (`character-list.js`) records it
   as the point the page's sync starts from. Nothing is held before this, so every character and
   group the page holds later was read at or after that point.
2. Two things then run side by side:
   - `printCharacters(true)` renders the first page of the character list from `/api/characters/query`
     (hash mode). A row the shown-row cache has under the same content key costs nothing more; the
     rest come from one `/api/characters/batch` request with `fields`.
   - `getCharacters()` brings the held characters and groups up to date (see below) and repaints;
     `reindexTagAssignments()` follows it.

There is no whole-library fetch, manifest or diff anywhere on this path. `/api/characters/manifest`,
`/api/characters/all` and `/api/groups/all` are removed.

## What the page holds

- **Characters:** only the ones it holds for use (the open character, group members, recently used
  characters), in `charactersStore`/`characters`. `selectCharacterByAvatar()` holds a character it
  doesn't hold from the `/api/chats/open` answer (`with_character`), so opening one is one request.
  The list itself holds only the rendered page
  (`renderedPageEntities`); `getEntitiesList()` reads that page, not a library array.
- **Shown rows:** an LRU cache of list rows the page has shown (`character-cache.js`), keyed by each
  row's content identity: a character's avatar, version (the log position of its last write) and tag
  hash; a group's id and its three digests. It is bounded by `ROW_CACHE_QUOTA_SHARE` of the quota
  `navigator.storage.estimate()` reports and kept in IndexedDB. Where the browser reports no quota
  (no `navigator.storage`, as on plain-http LAN installs), the cache lives in memory only, bounded by
  `MEMORY_ROW_CACHE_BYTES`. Query results with rows are not kept in memory; an unchanged page is
  rebuilt from the kept page (`query-result-cache.js`) and this cache.
- **Groups:** only the ones it shows in full (the open group chat, the group in the group panel), in
  `groupsStore`/`groups` (`group-store.js`); the rest are let go two seconds after a group is held or
  the open group or the group panel changes (`releaseUnshownGroupsSoon()`).
  `openGroupById()` holds a group it doesn't hold from the `/api/chats/open` answer (`with_group`), so
  opening one is one request. List, favourites, recent-chat and persona-connection rows are rows, not
  held groups: query rows, or `getGroupRows()` (`/api/groups/batch`).

## Keeping held characters and groups current

The change stream (`/api/characters/changes/stream`) tells the tab that something changed; the tab then
calls `getCharacters()`. `syncHeld()` reads `/api/characters/changes` from the recorded position (group
entries carry `type: 'group'`), keeps only the ids it holds, re-reads those (characters in full through
`characterRepository.readFull()`, groups through `takeInHeldGroupChanges()` and `/api/groups/batch`), and
drops held ones that were deleted. Changes to characters and groups the page doesn't hold download
nothing. A saved chat made, renamed or deleted for a character or group is logged as a change of that
owner (the engine's bookmark derivers in `engine/src/store/chat.rs`), so a held owner's chat list comes
up to date the same way; a message sent is not.

## Search and the list

The list, search included, pages through `/query`: the search term travels in the query's filter
(`buildCharacterQueryFromCurrentFilterState()`), so there is no client-side row resolution against a
local array. The group "add member" picker (`printGroupCandidates()`) pages through `/query` the same way.

## Still open

- Fully offline search (no server reachable) needs a client-side index of the library; none exists.
