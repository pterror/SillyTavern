The Manage Tags list is a Solid presentation surface over the existing tag controller in `public/scripts/tags.js`.
The controller retains server queries, bounded cursor paging, kept rows, persisted name drafts, tag edits and
cross-tab changes. It publishes row snapshots and injects actions; the surface does not fetch or access storage.

Solid owns the header, search and sort controls, editable rows and load status. Keyed reconciliation preserves
editors across refreshed snapshots and row moves. The existing sortable bridge restores the DOM before publishing
a changed row order, so it does not leave Solid's row order out of sync.

The delete/merge confirmation content is also Solid, mounted inside the existing shared popup shell. Its merge-target
search receives paged results through an injected port, ignores stale answers and keeps a chosen target across
searches. The interact select accepts a name renderer so tag looks apply to options and the selected target.
Deletion, refusal feedback and cross-tab updates stay in the existing tag controller. Restore and prune dialogs
continue to use their existing implementations.
