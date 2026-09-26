# Rules

## Scale

The entire architecture must scale to 10 billion cards.

Nothing may be O(total cards) in memory, reads, or scans on any request path, server or client. No loading, looping over, or keeping resident one entry per card. Every query and every client-side structure is scoped to what the request or view actually needs.

No `.all()` on database statements. Stream rows with `.iterate()`; anything that must be materialized goes through a read with an explicit bound.

## Tests

Subagents run only the tests covering what they changed, never the full suite. Every test run is scoped to the area the change actually touches.
