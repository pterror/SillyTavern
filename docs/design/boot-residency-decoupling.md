# Decoupling boot from full character residency

Scope note: this is a design pass on one specific gap, written to sit alongside
[`character-data-residency-redesign.md`](character-data-residency-redesign.md) (the "main" doc) rather
than duplicate it. The main doc's phase list (§9) never named `firstLoadInit()` / `getCharacters()` /
tag-map seeding as a phase — phase 5 targeted `getEntitiesList()`, `printCharacters()`, and the
destructive-existence sites, all of which are about *rendering and validating* the library, not about
*booting the app*. This doc is the missing piece: what would it take to stop boot itself from waiting on
the whole library, and is that even still the right target given what's already shipped since.

No code changes here. This is meant to inform a decision, not to be implemented from directly.

## 0. Status honesty — the main doc is stale, and not just at the point it admits

The main doc's own status table says it was reconciled against commit `11ee9c303`, with phases 3–5
listed as "not started." That table itself is now well behind HEAD. The doc file was last edited at
`c05c4da` (2026-08-22); HEAD at the time of this pass is `1bad61c` (2026-08-23), 27 commits later. In
that window, shipped:

- **Phase 4 (identity cutover)** — `this_chid`/`data-chid` removed (`53e79d4b0`), UUIDv7 minted at
  create/import (`7452c988e`), `/rename` collapsed to a card-data edit (`3c5e3bae3`).
- **Phase 5, client half, for render/browse** — `CharacterRepository` (`b37676e74`, `2b67cc7df`),
  `getEntitiesList()` inverted to a server-query page for the plain browse case (`24073de39`),
  server-paginated browse with merged character+group query (`5825088c4`), `filter.includeGroups`
  wired (`3f33c5611`), the §4.2 destructive-existence sites routed through `characterRepository.exists()`
  (`dfbd4c250`), and group residency (`validateGroup`/`getGroupMembers`/`getGroupCharacters`,
  `bac60a4bd`).
- **Phase 2's tantivy gap, the one thing the main doc's status table explicitly calls "entirely
  outstanding" and "the hard prerequisite"** — verified directly against `src/endpoints/characters.js:1705`:
  `QUERY_SORT_FIELDS` now includes `'random'` and `'search'`, both handled, not rejected. `/query`
  documents (line ~1717-1755) a working `filter.search` path through the tantivy/FTS index that composes
  with any sort field. This directly contradicts the main doc's own "Settled decisions the shipped code
  does not yet honour" entry for decisions 13/23 — that entry is now wrong, not just stale.

Net effect: most of what phase 5 needed from the server is already there, and most of the *render* path
(`printCharacters()`, `getEntitiesList()`, existence checks, groups) already goes through it when
eligible. The part that was never touched is boot's own array-hydration sequence
(`firstLoadInit()` → `getCharacters()` → `seedTagMapForResidentEntities()`), plus the one place the render
path still leans on a fully-populated array for a correctness-adjacent number (§2 below). One comment
in the code itself is now stale in the same way the main doc is:
`seedTagMapForResidentEntities()`'s own doc comment (`tags.js`) says "until phase 5 (bounded residency)
lands, 'resident at boot' is effectively the whole library" — but the group-residency slice of phase 5
already landed (`bac60a4bd`), so that sentence is talking about a state the codebase has partially moved
past.

Everything below is checked directly against files at `1bad61c` unless flagged otherwise.

## 1. What `firstLoadInit()` actually gates on

`public/script.js:843-848`:

```
await getCharacters();
await seedTagMapForResidentEntities();
```

Walking `getCharacters()` (script.js:1925-1965):

1. `fetchCharactersDelta()` (script.js:1823) — `POST /api/characters/manifest` (returns
   `{avatar, mtime, thumbnailVersion}` for **every** character in the library, unconditionally — this
   response itself is O(library size) even on a fully warm cache), diffs it against the IndexedDB cache
   (`diffCharacterManifest`), then a **sequential `for` loop** (script.js:1848, `await` inside the loop
   body, not `Promise.all`/`mapWithConcurrency`) over `/api/characters/batch` in
   `CHARACTER_BATCH_CHUNK_SIZE`-sized chunks for whatever's uncached/changed. Falls back to
   `fetchAllCharacters()` (`/api/characters/all`, fully unpaginated) on any failure.
2. `characters.splice(0, characters.length, ...newCharacters)` (script.js:1940) — replaces the whole
   module-level array in one shot.
3. `await getGroups()` (script.js:1963) — `POST /api/groups/all`. Cheap on its own (groups are far fewer
   than characters), **but** its legacy-format compat shim (`group-chats.js:953`,
   `characters.find(y => y.name == x)`) resolves old-format member lists by name against the `characters`
   array — this is why `getGroups()` is sequenced after the splice, not just historical accident. Narrow
   blast radius (only groups still in the pre-avatar-membership format), but it is a real, if small,
   coupling to full character residency.
4. `await printCharacters(true)` (script.js:1964) — the actual first render.

Then boot separately awaits `seedTagMapForResidentEntities()` (script.js:848, `tags.js:1019`): builds
`ids = [...characters.map(c => c.avatar), ...groups.map(g => g.id)]` and does one batched
`POST /api/tags/for` so tag pills/filters aren't empty. Its own doc comment states outright it "must run
after both `characters` and `groups` are populated."

**What's actually load-bearing vs. incidentally sequenced:**

- Step 1 (fetch + splice) is unavoidably O(library size) in *some* form today — nothing renders without
  `characters` existing in some shape.
- Step 4 (`printCharacters(true)`) does **not** structurally need the full array — it already branches on
  `canUseServerQueryForEntitiesList()` (script.js:1285), and at boot, with no active search and the
  default sort field, that condition is very likely to be `true` already (see §3). It is only sequenced
  after the full splice because it's called *from inside* `getCharacters()`, after step 2 — not because
  the render itself requires it.
- `seedTagMapForResidentEntities()` is the one boot-only call whose *shape* (batch every id in one
  request) structurally requires a complete id list at the moment it runs, not just as an implementation
  accident.
- One render-path correctness dependency on `characters.length` being the true library size survives
  independent of boot's own sequencing — see §2.

## 2. The one place a partial array would silently misreport

`makePageCallback()` in `printCharacters()` (script.js:1250):

```js
const hidden = (characters.length + groups.length) - getMatchTotal();
```

The comment right above it (script.js:1244-1249) explains this replaced an even worse version that
conflated "filtered out" with "not on this page," fixed by introducing `getMatchTotal()` — the real
match count for the active filter, sourced from the server query's `total` when the server-query path is
active. But the *subtraction's left side* is still `characters.length + groups.length`, used as "the
library-wide total." If `characters` only ever holds a partial/progressive slice, this badge — the
`"N hidden"` count shown when a filter is active — becomes wrong: either understated (if fewer than the
true total are resident) or, once residency is intentionally bounded rather than "whatever's loaded so
far," structurally wrong forever, not just transiently during boot.

This is not itself a blocker to any of the boot-decoupling approaches in §4, but any of them needs an
answer for this specific number: either replace it with a server-supplied library-wide count (the
`/query` response's `total` already is one, when unfiltered), or accept it reads wrong while
`characters` is still filling in.

## 3. `canUseServerQueryForEntitiesList()` as a candidate default boot path

`script.js:1491-1495`:

```js
function canUseServerQueryForEntitiesList() {
    if (entitiesFilter.getFilterData(FILTER_TYPES.SEARCH)) return false;
    if (isSearchSortSelected()) return false;
    const sortField = power_user.sort_order === 'random' ? 'random' : power_user.sort_field;
    return isServerQueryableSort(sortField);
}
```

`isServerQueryableSort()` (`character-repository.js:168`) is `true` for `'random'`, or for any field in
`QUERYABLE_CLIENT_SORT_FIELDS = {name, date_last_chat, chat_size, fav}` (character-repository.js:101).

**"Unsupported sort field" is a client-side scope decision, not a server limitation.** The server's own
`QUERY_SORT_FIELDS` (characters.js:1705) accepts seven fields — `name, date_added, date_last_chat,
chat_size, fav, random, search` — a strict superset of what the client will send. The gap is two fields,
each excluded for a documented reason (character-repository.js:88-98), not because `/query` rejects
them:

- `'create_date'` (the UI's "Newest/Oldest" dropdown option) reads the character card's own
  `create_date` field — an ISO string a card can carry from wherever it was originally authored. The
  server's `date_added` column is this install's own file-discovery time. They usually agree but are not
  the same value, so mapping the UI option onto the server column would be a silent behavior change for
  any imported card whose `create_date` predates when it landed on this install — deliberately excluded,
  not overlooked.
- `'data_size'` ("Most/Least tokens") has no server column at all — nothing computes or stores token
  count server-side today.

Search is excluded from this path for a separate, also-documented reason (script.js:1476-1488): a
*different*, already-working server search integration exists
(`fetchServerCharacterSearchResults()`/`entitiesFilter.searchFilter()`) that scores characters and groups
together and feeds an existing fuzzy/score-cache pipeline. `/query`'s `filter.search` goes through
tantivy/FTS, a different engine that doesn't necessarily agree on matches — composing the two risked a
character one engine matched getting silently dropped by the other. This exclusion is now the part of
the design most worth re-checking: the main doc's status table calls the tantivy gap "the hard
prerequisite" for phase 5, but per §0 that gap has since closed server-side. The exclusion in
`canUseServerQueryForEntitiesList()` may now be leftover caution from when it was written, rather than a
condition that still needs to hold — **unverified**, this doc did not test whether the two search paths
actually diverge in practice; it only confirms the server-side capability the original exclusion was
written around no longer has the shape the exclusion assumed.

**What this means for boot specifically:** at first paint, with no search term and the sort field at
whatever the user last had it (or the app default), `canUseServerQueryForEntitiesList()` is very likely
`true` already — meaning the *first render* boot produces today, via `printCharacters(true)` inside
`getCharacters()`, is probably already being built off a server-paged query rather than a locally-sorted
scan of the full array, even though it's gated behind the full fetch completing first (§1). The
server-query path itself imposes no residency requirement — it pages directly from `/query`. What still
needs the full array, if this became boot's primary/default path rather than a fallback, is everything
*not* covered by `canUseServerQueryForEntitiesList()`'s scope: an active search term at boot (unusual but
possible if state is restored), a sort field outside the four queryable ones, and the two boot-only
calls in §1 (tag seeding, the legacy-groups shim) plus the `characters.length` reliance in §2.

## 3.5 New constraint: client-side search must stay usable under high latency (owner requirement)

The owner has named this explicitly (tailscale-over-mobile-data was the example), not as an incidental
fallback — a real requirement any of §4's approaches has to hold up under. This changes what "search"
means for the purposes of this doc, so it's worth checking against code before §4's tradeoffs, not after.

**Verified: search-active state already, today, unconditionally requires the full local `characters`
array — independent of anything in this doc.** `getEntitiesList()` (script.js:1654-1664):

```js
const characterAndGroupEntities = doFilter && canUseServerQueryForEntitiesList()
    ? await (async () => { /* server /query page */ })()
    : [
        ...characters.map(item => characterToEntity(item)),
        ...groups.map(item => groupToEntity(item)),
    ];
```

`canUseServerQueryForEntitiesList()` returns `false` whenever a search term is active (§3). So the moment
a user types a search, `getEntitiesList()` falls straight to the local-array branch — `characters.map()`
over the *entire* module-level array — regardless of which boot approach is chosen. This is true at HEAD,
today, before any of this doc's changes land.

Layered on top of that: `fetchServerCharacterSearchResults()` (script.js:12001) *does* already call the
server (`POST /api/characters/all` with a `search` param — a different, filtered mode of that endpoint,
not the bulk unpaginated one) and gets back ranked `{characterScores, groupScores, total}` without
needing local residency to compute the ranking. But the objects those ranks get attached to for
display — the actual character rows — still come from the local-array branch above. So today's search
path is a hybrid: server-side relevance scoring, client-side row resolution assuming full residency.

**What this means for each of §4's approaches, concretely:**

- Under the *current* code (neither A nor B), this hybrid already works, because boot guarantees full
  residency before anything is interactive — search never runs against a partial array.
- Under **B** (stop awaiting the full chunked fetch, show first chunk, reconcile as more arrive), a
  search issued before the background fill completes hits the exact same local-array branch, now
  partially populated — scored ranks come back correctly from the server, but rows for characters not
  yet resident silently have nothing to attach to. B does not fix this and does not make it worse than A;
  it has the identical gap, just reached from "chunked fetch still filling" instead of "server-query
  deferred a full fetch entirely."
- Under **A** (defer the full array fetch to a background fill), the same gap exists, but the *exposure
  window* is different in a way that matters for the stated constraint: A's entire value proposition is
  built on the background fill being allowed to take a while (that's what makes boot fast). Under high
  latency specifically, that fill is exactly the slow part — the sequential chunked fetch A defers is the
  same one B still runs, just relocated off the critical path rather than sped up. A user on a slow
  tailscale link who searches soon after boot (plausible — searching is often the first thing done on a
  large library) hits the gap during a *longer* window than under B, on the connection where it's least
  affordable to be wrong.

**This is not a reason to prefer B — B has the identical structural gap and no plan to close it either.**
It's a reason the gap can no longer be scoped out of whichever approach ships: search resolving rows
via `characters.map()` over the resident array is the actual thing that needs to change, and it's
orthogonal to which boot-sequencing approach is chosen. The fix shape already exists in the codebase and
doesn't need to be invented: `CharacterRepository.getMany()` (character-repository.js:292) already does
exactly this — resident ids resolve locally, ids that aren't resident get one batched `/query` call keyed
on `filter.ids`. Routing the search-active branch of `getEntitiesList()` through `repository.getMany()`
(resolving `characterScores`' matched ids that way, instead of assuming every ranked id is already in
`characters`) would close the gap for both A and B, and is the same "ask the server for exactly what's
missing" pattern phase 5 already established for the plain-browse case — search is the one place that
pattern was deliberately left out (§3's documented scope boundary), and this constraint is the reason to
revisit that boundary specifically, not to abandon server-query as the direction.

**Separately, and not solved by any of the above:** the owner's example (tailscale over mobile data) is
high-latency-but-reachable, not offline. A genuinely unreachable server — connectivity dropped entirely —
is a different case that neither A, B, nor the `getMany()` fix touches: at that point every approach here
that still round-trips to `/query` for anything not already resident simply fails for that anything. The
main doc already treats fully-offline-capable client search as a settled requirement (§0 item 3, "a real
client-side index library... to answer searches without a round trip on a slow link... alongside — not
instead of — server-side search"; decisions 9/12/14/18-21 spec it as MiniSearch over IndexedDB-persisted
shallow rows) — but per §0 of this doc, that's phase 6, and nothing in the repo implements it yet (no
`MiniSearch` import anywhere in `public/`, checked directly). Whichever boot approach ships, it produces
no offline-search capability on its own — that's a separate, currently-unstarted track, and if the
owner's requirement extends to true offline (not just high-latency-but-connected), that track needs
prioritizing as its own piece of work, not folded into a boot-sequencing decision.

## 4. Approaches, and their tradeoffs

Laid out for the call, not ranked. All three assume the render path itself (`printCharacters`,
`getEntitiesList`) keeps working as-is — the gap being closed is what boot does *before* first paint,
and what happens to the boot-only calls that currently assume a populated array.

### A. Boot goes straight through the server-query path; `characters` fills in as a background task

Reorder `firstLoadInit()` so the first `printCharacters()` call happens via
`canUseServerQueryForEntitiesList()`'s path directly (bypassing the wait on `getCharacters()`'s full
splice), then run the manifest/batch fetch and array population as a non-blocking background fill.

- **Removes** the O(library size) wait from the critical path entirely for the eligible case (§3) — first
  paint depends only on one `/query` page.
- **Requires deciding what "background fill" means for the two boot-only calls in §1**:
  `seedTagMapForResidentEntities()` can't batch "every id" if the id list isn't known yet — either it
  needs to become progressive (seed per-page/per-chunk as characters arrive, or move to an on-demand
  per-row fetch through `/api/tags/for` scoped to whatever's actually rendered, which is a different and
  smaller request shape than what exists today), or it stays boot-blocking and becomes the new critical
  path once the array fetch itself is removed from it. Either way this is real design work, not a
  reorder — the function's current shape (one batch call over a known-complete id list) doesn't have an
  obvious drop-in progressive equivalent.
- The legacy-groups membership shim (§1, `group-chats.js:953`) would need `getGroups()` decoupled from
  assuming `characters` is complete, or the shim would silently fail to resolve old-format members for
  characters that haven't loaded yet. Likely narrow in practice (only pre-avatar-membership groups), but
  unverified how many exist on this install.
- The `characters.length` reliance (§2) either needs a replacement source (server-supplied total) or
  stays wrong while the background fill is in flight — and forever, if this is combined with actually
  bounding residency (not just deferring full load) rather than eventually catching up to full.
- Ineligible boot states (active search restored from session, or `sort_field` outside the four
  queryable ones) fall back to the current wait-for-everything behavior, so this doesn't uniformly fix
  boot — it fixes the common case and leaves an edge case with today's cost.
- **§3.5**: search-active state resolves rows against the local `characters` array regardless of boot
  approach, so A's background fill widens the window where that resolution can be wrong, specifically
  under the high-latency case the fill is slowest for. Not disqualifying, but it means A isn't complete
  without also routing search-active row resolution through `characterRepository.getMany()` — that fix
  is what makes "defer the fetch" actually safe to search against, not an optional follow-up.
- This is the approach that most directly follows through on what phase 5 already established for
  render/browse — it's applying the same "server owns the query, client doesn't need the whole set" model
  one layer earlier, at boot, rather than introducing a new mechanism.

### B. Keep the batch-chunk fetch, stop `await`ing all of it before first paint

Show the first chunk (or first page-worth) immediately, keep `fetchCharactersDelta()`'s existing chunked
fetch running in the background, and reconcile `characters`/`charactersStore` incrementally as more
chunks land (`charactersStore.reportCreated()` per chunk, rather than one `reset()` at the end).

- Smaller structural change than A — keeps the existing fetch/cache/manifest-diff machinery
  (`diffCharacterManifest`, IndexedDB cache, `saveCachedCharacters`/`pruneCharacterCache`) exactly as-is,
  just changes when the UI is allowed to start rendering relative to it finishing.
- Doesn't remove the O(library size) manifest round-trip itself (`POST /api/characters/manifest` still
  returns every avatar's mtime up front, per §1) — this approach only stops the *rendering* from waiting
  on the batch loop, not the manifest fetch that precedes it. On a 1M-character library that manifest
  response is itself a cost this approach doesn't touch.
- `seedTagMapForResidentEntities()` has the same problem as in A — its one-shot full-id-list shape doesn't
  have an obvious progressive form, so this approach doesn't sidestep that design work either.
- First paint under this approach would still be sorting/filtering over whatever's resident so far via
  the *local* candidate-building path (unless combined with A's server-query default), so "first usable
  UI" quality depends on chunk order — if the manifest/batch order isn't meaningful (e.g. filesystem
  order), the first chunk shown may not correlate with what the user actually wants to see first
  (recently used, alphabetically first, etc.), whereas A's server-query page is sorted correctly from the
  first request regardless of fetch order.
- Keeps `characters.length` (§2) converging toward correct as the background fill completes, rather than
  needing a structural replacement — arguably simpler to reason about than A here, at the cost of being
  transiently wrong during the fill window either way.

### C. Something else — narrower scope, or a hybrid

Not fully worked out here, flagged because A and B aren't necessarily exclusive and a narrower first step
exists:

- Ship just the tag-seeding fix (make `seedTagMapForResidentEntities()` progressive or on-demand) without
  touching the array-fetch/render sequencing at all. This alone doesn't reduce boot's wait time, but it
  removes the one boot-only call whose *shape* (not just its sequencing) assumes full residency — meaning
  it's a prerequisite either A or B eventually needs, and could land independently and first, to validate
  the progressive-seeding approach before committing to a bigger reorder.
- A vs. B aren't mutually exclusive either: B's incremental reconciliation could be the *background fill*
  mechanism A uses once first paint has already happened via the server-query path — i.e., A determines
  what boot shows first, B determines how `characters` catches up afterward. Whether that combination is
  worth the added complexity over picking one is itself a tradeoff, not resolved here.

## 5. What this doc does not know

- Whether the two search engines (`fetchServerCharacterSearchResults()`'s fuzzy pipeline vs. `/query`'s
  tantivy/FTS) actually produce divergent results in practice now that tantivy search is server-complete
  — the exclusion in `canUseServerQueryForEntitiesList()` was written when the tantivy gap was open; it's
  unverified whether the concern that motivated it still holds now that it's closed.
- How many groups on this install are still in the pre-avatar-membership legacy format (bearing on how
  much the `getGroups()`/`characters` coupling in §1 actually matters in practice).
- Whether `/api/characters/manifest`'s full-library response (avatar/mtime/thumbnailVersion for every
  character, unconditionally) has its own scaling ceiling worth addressing before or alongside any of
  §4's approaches — noted in passing in option B but not sized against the 300k/1M-10M targets.
- Any interaction with extensions that read `characters`/`charactersStore` at boot before the array is
  fully populated — the main doc's §9.4 extension-compatibility work (decision 22) assumes full
  resident arrays for legacy extensions; a boot sequence that intentionally delays population changes
  *when* that assumption becomes true, which §9.4 doesn't appear to have been written against.
- Whether the owner's high-latency requirement (§3.5) extends to genuinely offline use, or is scoped to
  "slow but connected" (the tailscale example given). This matters because the two have different
  answers: slow-but-connected is addressed by routing search through `characterRepository.getMany()`
  (§3.5) regardless of which boot approach ships; genuinely offline needs the unstarted phase 6 local
  index (MiniSearch — confirmed absent from `public/` by direct search, not just undocumented) and isn't
  solved by anything in §4 at all.
- Whether `fetchServerCharacterSearchResults()`'s `getMany()`-style fix (§3.5) also needs to cover the
  bogus-folder tile path (`getFolderTileEntities()`, script.js:1687) and `favsToHotswap()`, both of which
  the main doc and this pass's research flagged as other local-array readers but didn't trace in the
  same depth as the search path.
