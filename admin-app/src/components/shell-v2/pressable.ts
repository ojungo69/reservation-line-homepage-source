// Press feedback and color changes for V2 shell controls (emil-design-eng: a
// short ease-out scale on press). Both stop under reduced motion.
export const PRESSABLE =
  "transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cal-primary";
