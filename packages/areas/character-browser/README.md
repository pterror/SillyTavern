The Solid results and pagination surfaces draw the latest answer from the existing character repository. Its cache,
background refreshes, saved-view pins and query protocol remain in place during this presentation migration.

`public/scripts/character-list.js` bridges filter and page requests to that repository, presents its answers, and keeps
the existing scroll and unread-progress behavior. Rows receive plain tag and group-avatar snapshots; Solid owns
those children, including chip expansion. There are no separately mounted row-chip roots or avatar decorators.

Group member and candidate rows and their pagination are Solid surfaces too. `group-chats.js` supplies repository
answers and membership actions through explicit ports. The member popout renders the same member view through its
own Solid tree, with unique controls and automatic disposal; it never clones rendered HTML. Query request counters
reject late answers, and current row tag IDs participate in retention and cross-tab rereads, including hidden and
overflow tags. The surrounding group editor and missing-member report remain legacy surfaces.

The search pills, sort picker, tag filter bar and saved-view picker are also Solid surfaces. `character-list.js`,
`tags.js` and `saved-views.js` keep the query, persistence and tag-management intents, and publish snapshots through
`characterBrowser.controls`. Components receive those snapshots and injected actions; they do not fetch or read
storage. The legacy folder drilldown remains a decorated leaf beside the Solid tag filter bar.
