The Manage Tags list is a Solid presentation surface over the existing tag controller in `public/scripts/tags.js`.
The controller retains server queries, bounded cursor paging, kept rows, persisted name drafts, tag edits and
cross-tab changes. It publishes row snapshots and injects actions; the surface does not fetch or access storage.

Solid owns the header, search and sort controls, editable rows and load status. Keyed reconciliation preserves
editors across refreshed snapshots and row moves. Handles use the shared `@st/page/reorder` helper over interact's
drag primitive. Pointer dragging and Arrow Up/Down send move intents; Solid renders the insertion indicator and
orders keyed rows from snapshots. No drag code reorders DOM nodes. The controller retains the existing server
move/reorder requests and refusal feedback. Editing and active moves defer stale-list refreshes; focused buttons
do not prevent a refused move from restoring the server's order.

The delete/merge confirmation content is also Solid, mounted inside the existing shared popup shell. Its merge-target
search receives paged results through an injected port, ignores stale answers and keeps a chosen target across
searches. The interact select accepts a name renderer so tag looks apply to options and the selected target.
Deletion, refusal feedback and cross-tab updates stay in the existing tag controller.

Prune and restore confirmation content and the restore warning report are Solid surfaces inside the same popup
shell. The controller retains counting, batched pruning, backup parsing, overwrite choices and partial-failure
handling. Warning lines render as text, including names and errors from the restored backup.

Character, group and bulk assignment inputs use the shared `@st/page/autocomplete` surface, which combines Solid
rendering with interact's movement and popover modules. The tag surface owns transient text and search results;
`tags.js` injects name lookup, creation and assignment. It captures the destination before an asynchronous create.
Transient bulk popups dispose their input before removing the popup, so pending reads cannot reopen suggestions.

Assigned chips and the collapsed character-tag preview are Solid surfaces too. `tags.js` keeps complete tag IDs
outside the displayed 50-chip window and publishes keyed snapshots; both character and group creation read those
IDs. Removal actions stay injected, including bulk callbacks that can refuse a removal. The preview is passive,
and transient bulk lists are disposed with their input.

Chip presentation lives in `@st/page/tags`, shared with character-browser rows. Inline chips are ordinary children
of Solid rows: expansion lasts for that row, and removing it disposes its children automatically. The legacy tag
controller publishes data updates instead of replacing inline chip DOM.
