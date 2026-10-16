// Public API of the mascot system. Other code imports only from here, but for the /mascots gallery page, which the
// app loads on its own (its own chunk) from ./MascotGallery.
export { Mascot, type MascotProps } from "./Mascot";
export { MascotPicker, type MascotPickerProps } from "./MascotPicker";
export { MascotStage, type MascotStageProps } from "./MascotStage";
export {
  MASCOT_ACCESSORIES,
  MASCOT_COLORS,
  MASCOT_EYES,
  MASCOT_SHAPES,
  defaultMascot,
  randomMascot,
  mascotLabel,
  suggestName,
} from "./catalog";
