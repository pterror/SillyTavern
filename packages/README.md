# packages/: the new code

Everything here replaces old code under `public/` and `src/`, one area at a time; an area's old module is deleted in
the commit that lands its replacement. Read this before reading old code: old code shows what a feature does, never
how new code is shaped.

## The shape

- **The server owns state; the page draws it.** The page keeps no copy of anything it could compute or that the
  server stores. It holds the latest view the server sent for each thing it shows, and nothing else.
- **The page sends actions** (`{ type, payload }`): what the user did, never the state it leads to. The answer to
  an action carries the new view of everything the action changed that this tab shows.
- **Showing something is an action too** (`view.open`): its answer is the view. A view changed by something else
  (another tab, another action of this tab, a write made through old code) is pushed to the tabs showing it.
- **Every view has a version.** The page keeps a view only when it's newer than the one it has, so an answer and a
  push can arrive in any order and the page still ends at the latest.
- **Correctness never waits.** No timers, debounces or polls decide what the page shows.
- **What a tab shows is server state** (its session, its current chat), so a view can depend on it and the server
  can push it when it changes.
- **New code never imports old code.** Where an area needs something only old server code does (a chat's state, a
  file write), the area declares an interface for it and the server's wiring passes old code in. Old code may
  import new code; the arrow only points that way.
- **Upstream's names stay.** Extensions import old paths (`/scripts/backgrounds.js`) and read old globals; those
  paths become small stubs over the new code, kept for as long as extensions use them.

## Packages

The core is what every area builds on; each area is a package of its own, the way an extension would be one. An area
reaches the core and nothing else (`st/declared-imports` holds it to its package.json): never another area, and never
old code. What an area needs that the core doesn't give is a gap in the core, not a reason to reach across.

- `protocol`: what an action and a view are, as schemas both sides use (the server validates every action with them).
- `server-ui`: the server side: the area registry, `POST /api/ui/action`, the tabs and what each shows, pushes.
- `page`: the page's core (Solid): the client (the one module that talks to the server), the context, layers.
- `areas/<name>`: an area: `protocol.ts` (its actions and views), `server.ts` (its area for `server-ui`, with the
  ports old code implements), `page/` (its surfaces and the stubs over them, exported from `page/index.ts`).
- `ui`: the page's entry: mounts each area's surfaces in the old page's containers (compiled by vite-plugin-solid).
  The server's side of the same is `src/ui-wiring.js`.
- `serve-ui`: builds `ui` and the old page's libraries (`/lib.js`, `/live-editor-lib.js`), takes their build from
  CI's release for the source (built here only for unreleased source), and serves it.
- `lint`: the rules that keep this shape (see `lint/config.ts`).

## Checks

`npm run check:packages` (format, lint, strict types) and `npm run test:packages`. The pre-commit hook runs both;
nothing here is allowed a known failure.
