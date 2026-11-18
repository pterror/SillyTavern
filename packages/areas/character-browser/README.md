The Solid results and pagination surfaces draw the latest answer from the existing character repository. Its cache,
background refreshes, saved-view pins and query protocol remain in place during this presentation migration.

`public/scripts/character-list.js` bridges filter and page requests to that repository, presents its answers, and keeps
the existing scroll and unread-progress behavior. Its tag and group-avatar decorators own only their empty leaf
containers. Solid owns the result rows and pagination; legacy callers update them through `characterBrowser.show`.

The search pills, sort picker, tag filter bar and saved-view picker are also Solid surfaces. `character-list.js`,
`tags.js` and `saved-views.js` keep the query, persistence and tag-management intents, and publish snapshots through
`characterBrowser.controls`. Components receive those snapshots and injected actions; they do not fetch or read
storage. The legacy folder drilldown remains a decorated leaf beside the Solid tag filter bar.
