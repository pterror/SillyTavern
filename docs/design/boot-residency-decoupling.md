# Decoupling boot from full character residency

This doc was a design pass on one gap: boot waited on the whole character library before the app
was usable. Its options (render first and fill the library in the background, or keep the chunked
fetch and stop awaiting it) are moot: the page no longer holds the library at all. What follows is
what boot does now, for the next reader. The main design doc is
[`character-data-residency-redesign.md`](character-data-residency-redesign.md).

## What boot does

`firstLoadInit()` (`public/script.js`):

1. `getSettings()` reads `/api/settings/get`. Its answer carries `characterChangesSeq`, the end of the
   server's change log at that moment, and `startCharacterChangesAt()` (`character-list.js`) records it
   as the point the page's character sync starts from. Nothing is held before this, so every
   character the page holds later was read at or after that point.
2. Two things then run side by side:
   - `printCharacters(true)` renders the first page of the character list from `/api/characters/query`
     (hash mode). A row the shown-row cache has under the same content key costs nothing more; the
     rest come from one `/api/characters/batch` request with `fields`.
   - `getCharacters()` brings the held characters up to date (see below), reads the groups, and
     repaints; `reindexTagAssignments()` follows it.

There is no whole-library fetch, manifest or diff anywhere on this path. `/api/characters/manifest` and
the unsearched `/api/characters/all` stream are removed.

## What the page holds

- **Characters:** only the ones it holds for use (the open character, group members, recently used
  characters), in `charactersStore`/`characters`. The list itself holds only the rendered page
  (`renderedPageEntities`); `getEntitiesList()` reads that page, not a library array.
- **Shown rows:** an LRU cache of list rows the page has shown (`character-cache.js`), keyed by each
  row's content identity: a character's avatar, version (the log position of its last write) and tag
  hash; a group's id and its three digests. It is bounded by `ROW_CACHE_QUOTA_SHARE` of the quota
  `navigator.storage.estimate()` reports and kept in IndexedDB. Where the browser reports no quota
  (no `navigator.storage`, as on plain-http LAN installs), the cache lives in memory only, bounded by
  `MEMORY_ROW_CACHE_BYTES`. Query results with rows are not kept in memory; an unchanged page is
  rebuilt from the kept page (`query-result-cache.js`) and this cache.
- **Groups:** every group. `getGroups()` reads `/api/groups/all`, which streams all of them, on each
  `getCharacters()`. This is the one whole-collection read left on the boot and sync path.

## Keeping held characters current

The change stream (`/api/characters/changes/stream`) tells the tab that something changed; the tab then
calls `getCharacters()`. `syncHeldCharacters()` reads `/api/characters/changes` from the recorded
position, keeps only the ids it holds, re-reads those in full (`characterRepository.readFull()`), and
drops held characters that were deleted. Changes to characters the page doesn't hold download nothing.

## Search and the list

The list, search included, pages through `/query`: the search term travels in the query's filter
(`buildCharacterQueryFromCurrentFilterState()`), so there is no client-side row resolution against a
local array. The group "add member" picker (`printGroupCandidates()`) pages through `/query` the same way.

## Still open

- Groups are read whole (above).
- Fully offline search (no server reachable) needs a client-side index of the library; none exists.
