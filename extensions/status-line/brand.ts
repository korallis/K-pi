export type BrandPreset = "unicode" | "nerd" | "ascii";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function renderIdleBrand(preset: BrandPreset = "unicode"): string {
  if (preset === "ascii") return "K-pi";
  if (preset === "nerd") return "K-󰵗";
  return "K-π";
}

export function renderWorkingBrand(
  elapsedMs: number,
  frame = 0,
  preset: BrandPreset = "unicode",
): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (preset === "ascii") return `K-pi ~ ${seconds}s`;
  return `${renderIdleBrand(preset)} ${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${seconds}s`;
}
