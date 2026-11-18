The Solid results and pagination surfaces draw the latest answer from the existing character repository. Its cache,
background refreshes, saved-view pins and query protocol remain in place during this presentation migration.

`public/scripts/character-list.js` bridges filter and page requests to that repository, presents its answers, and keeps
the existing scroll and unread-progress behavior. Its tag and group-avatar decorators own only their empty leaf
containers. Solid owns the result rows and pagination; legacy callers update them through `characterBrowser.show`.
