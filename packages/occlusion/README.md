# @st/occlusion

Cuts what is covered out of what is under it, so see-through layers never show two things in one place. No framework
and no knowledge of any app: it is given a root, an optional stack of elements whose order the app sets, and policies.

## The model

- **What takes part is found from how the page paints**, never registered: the stack's members, and every shown
  element that paints over other content (positioned fixed or sticky, in the top layer, or positioned absolute to the
  page or past the box it is positioned in). Absolute inside its own box is part of that box, not over anything; an
  element holding members is their container, not something over them.
- **What is in front of what**: members follow the stack's order, even where painting disagrees (the lower one is cut
  where the upper one is, which is what shows the order). An overlay inside a member is drawn with it: in front of it,
  behind what is in front of it. An overlay outside every member is in front of the members it paints above, by the
  z-index of its top-level stacking context; one painting below every member is the backdrop and cuts nothing. The top
  layer is in front of everything.
- **What a layer covers is what it paints**: its box (with its rounded corners, trimmed by its own `clip-path: inset()`)
  when it draws a background, border, shadow, blur or text of its own; else what its children paint. A `coversBox`
  policy makes it its whole box.
- **What is cut**: every layer, where layers in front of it cover it; and inside a member, under each overlay drawn with
  it, the content along the overlay's path that paints before it. A cut is a `clip-path` on the element (so a cut part
  takes no clicks either), marked `data-occluded="cut"`; an element hidden whole is marked `data-occluded="hidden"`.
  A layer hidden whole covers nothing.
- **Policies** decide what happens to a covered element, each for the elements its matcher picks: `exempt` (never cut),
  `squareCorners` (holes don't keep the covers' rounded corners), `hideWhenCovered`, `hideWhenSplit` (hidden whole when
  one hole leaves it in pieces; thresholds and extra covers as options), `coversBox`. A new policy is a new object with
  `matches` and any of `coversBox`, `holes`, `hides`; the core doesn't change.
- **Off**, everything is put back and nothing is watched.

## Cost

- The positioned elements are kept from the page's own mutations while on: an added subtree, or an element whose
  class (it and what is under it), style or state attribute changed, is looked at once. Text changes aren't watched.
  Turning it on looks at the whole root once.
- An update reads the boxes of the members, of the positioned elements, and, for each overlay inside a member, of the
  siblings along its path; it writes only what changed. Updates run when something changed, on the next frame, and
  every frame after while a layer moves or animates or the page scrolls under an overlay; never on a timer.

## Use

```ts
const occlusion = createOcclusion({
    stack: { members: () => panels, compare: (a, b) => order(a) - order(b) },
    policies: [coversBox(isPanel), hideWhenCovered(() => true), hideWhenSplit(isWide, { alsoCoveredBy: () => [bar] })],
    onHiddenChange: () => {
        /* something became or stopped being hidden whole */
    },
});
occlusion.setEnabled(true);
occlusion.stateOf(element); // 'cut' | 'hidden' | null
```
