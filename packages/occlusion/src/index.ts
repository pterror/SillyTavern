export { createOcclusion, STATE_ATTRIBUTE } from './occlusion.ts';
export type { Occlusion, OcclusionOptions, Stack, State } from './occlusion.ts';
export { coversBox, exempt, hideWhenCovered, hideWhenSplit, squareCorners } from './policies.ts';
export type { Policy, SplitOptions, Target } from './policies.ts';
export { clipPathFor, holesIn, insetBox, uncoveredPieces, unionArea } from './geometry.ts';
export type { Radii, Rect } from './geometry.ts';
