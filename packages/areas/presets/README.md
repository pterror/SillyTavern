Solid owns the four generation-preset surfaces. The server owns their catalogs, selection, and ordering;
`presetsCompat` waits for the generation adapters to apply each received view before an action completes.

`public/scripts/preset-manager.js` projects catalogs into the existing generation modules' arrays and name maps,
then calls explicit backend application functions. There are no hidden generation selects, option projections,
MutationObservers, or synthetic select changes. Manager name lookup and selection reads use catalog/settings data,
while its option-value methods retain string indexes for indexed backends and names for keyed backends.

Backend application functions retain provider-specific field handling and extension hooks. Chat Completion waits
for both preset hooks and settings synchronization. The connection-binding option is a server-owned Solid preset control, written at the user level independently
of character or chat sampler overrides, rather than a control hidden with the old preset markup.

Advanced-formatting template selectors remain separate legacy surfaces; they still use their existing manager.
