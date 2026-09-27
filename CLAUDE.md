# Rules

## Scale

The entire architecture must scale to 10 billion cards.

Nothing may be O(total cards) in memory, reads, or scans on any request path, server or client. No loading, looping over, or keeping resident one entry per card. Every query and every client-side structure is scoped to what the request or view actually needs.

No `.all()` on database statements. Stream rows with `.iterate()`; anything that must be materialized goes through a read with an explicit bound.

## Tests

Subagents run only the tests covering what they changed, never the full suite. Every test run is scoped to the area the change actually touches.

## Compat

Breaking is forbidden. Upstream (upstream/staging) exports, their signatures and parameter meanings, event payloads, routes, and third-party extensions keep working. Never change third-party extensions. For every upstream parameter, handle each input exactly as upstream does.

## Client

Clients only send actions.

## Loading

Anything the client might already have is fetched conditionally against its cached hash. Nothing loads until it is on screen, except chat bodies, which always load whole. IDB space is limited.

## Memory

The JS heap holds only what the current view needs. IDB may cache more, within a budget.

## Data safety

Correct over fast. Never lose data. Never drop anything silently: warn, listing what was dropped. No writes without a real change.

## Tree model

Conversations are a message tree per owner plus a pointer to a node. A chat is a minimal shim over a bookmark. Bookmarks either follow the conversation or stay pinned.

## Boot and batches

Nothing heavy blocks listen. Big passes run in workers, in batches that yield, and never hold a reader across writes.
