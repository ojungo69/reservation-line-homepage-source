// Press feedback and color changes for V2 shell controls (emil-design-eng: a
// short ease-out scale on press). Both stop under reduced motion. outline-hidden
// (not outline-none) keeps a real outline for focus in forced-colors mode, where
// the box-shadow ring is dropped.
export const PRESSABLE =
  "transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cal-primary";

// Keyboard focus on a dropdown item: the shared item only tints its fill (about
// 1.1:1 against the menu) and sets outline-none, so V2 menus add a primary ring
// (3:1 or more) and outline-hidden for an outline in forced-colors mode.
export const MENU_ITEM_FOCUS =
  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cal-primary";
