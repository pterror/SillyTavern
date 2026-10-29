// Upstream's swipe picker is the alternatives list now (public/scripts/alternatives.js over packages/areas/
// alternatives); its exports stay at this path for extensions that import them.

export { canJumpToSwipeForMessage, canOpenSwipePickerForMessage, initSwipePicker } from './alternatives.js';
