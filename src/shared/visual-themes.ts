export interface NativeThemePalette {
  background: string;
  card: string;
  tab: string;
  symbol: string;
}

export interface VisualThemeDefinition {
  name: string;
  native: { light: NativeThemePalette; dark: NativeThemePalette };
  backgrounds?: Record<string, BackgroundPreset>;
  defaultBackground?: string;
}

export interface BackgroundPreset {
  name: string;
  file: string;
  position: string;
  artTint: string;
  contentTint: string;
  controlTint: string;
  mask: string;
  foreground: string;
  mutedForeground: string;
}

export const elysiumBackgrounds = {
  skyline: {
    name: "Skyline",
    file: "themes/elysium/backgrounds/disco-skyline-wallpaper-4k.png",
    position: "50% 48%",
    artTint: "#171c2080",
    contentTint: "#171c20d9",
    controlTint: "#283638e8",
    mask: "linear-gradient(90deg, #10171bd9 0%, #10171b80 42%, #10171b10 100%)",
    foreground: "#eee8da",
    mutedForeground: "#d6d5c9",
  },
  church: {
    name: "Church",
    file: "themes/elysium/backgrounds/disco-church-wallpaper-4k.png",
    position: "55% 48%",
    artTint: "#1b1c20a3",
    contentTint: "#1b1c20df",
    controlTint: "#333f42eb",
    mask: "linear-gradient(90deg, #11171bdf 0%, #11171b85 44%, #11171b16 100%)",
    foreground: "#eee8da",
    mutedForeground: "#d6d5c9",
  },
  conquest: {
    name: "Conquest",
    file: "themes/elysium/backgrounds/disco-conquest-wallpaper-4k.png",
    position: "52% 50%",
    artTint: "#1b2023a3",
    contentTint: "#1b2023df",
    controlTint: "#344747eb",
    mask: "linear-gradient(90deg, #13191ddd 0%, #13191d80 44%, #13191d12 100%)",
    foreground: "#eee8da",
    mutedForeground: "#d6d5c9",
  },
  ruud: {
    name: "Ruud",
    file: "themes/elysium/backgrounds/disco-ruud-wallpaper-4k.png",
    position: "50% 42%",
    artTint: "#202021a3",
    contentTint: "#202021df",
    controlTint: "#393d3deb",
    mask: "linear-gradient(90deg, #17191bdf 0%, #17191b85 44%, #17191b12 100%)",
    foreground: "#eee8da",
    mutedForeground: "#d6d5c9",
  },
  thoughtcabinet: {
    name: "Thought Cabinet",
    file: "themes/elysium/backgrounds/disco-thoughtcabinet-wallpaper-4k.png",
    position: "50% 46%",
    artTint: "#1a1c22a3",
    contentTint: "#1a1c22df",
    controlTint: "#303b45eb",
    mask: "linear-gradient(90deg, #13171edf 0%, #13171e85 44%, #13171e12 100%)",
    foreground: "#eee8da",
    mutedForeground: "#d6d5c9",
  },
} as const satisfies Record<string, BackgroundPreset>;
export const visualThemes = {
  original: {
    name: "Original",
    native: {
      light: { background: "#fbfcf9", card: "#ffffff", tab: "#e0e8db", symbol: "#193c35" },
      dark: { background: "#17231f", card: "#1d2c25", tab: "#111b17", symbol: "#f1f6e9" },
    },
  },
  slate: {
    name: "Slate",
    native: {
      light: { background: "#f2f5f9", card: "#ffffff", tab: "#dce5ef", symbol: "#253b56" },
      dark: { background: "#141c29", card: "#202c3e", tab: "#101827", symbol: "#e9f2ff" },
    },
  },
  elysium: {
    name: "Elysium",
    native: {
      light: { background: "#252d2e", card: "#344747", tab: "#171c20", symbol: "#eee8da" },
      dark: { background: "#171c20", card: "#293638", tab: "#111619", symbol: "#eee8da" },
    },
    backgrounds: elysiumBackgrounds,
    defaultBackground: "skyline",
  },
} as const satisfies Record<string, VisualThemeDefinition>;

export type VisualThemeId = keyof typeof visualThemes;
export const visualThemeIds = Object.keys(visualThemes) as VisualThemeId[];
export function backgroundsForTheme(theme: unknown): Record<string, BackgroundPreset> | undefined {
  const definition: VisualThemeDefinition = visualThemes[resolveVisualTheme(theme)];
  return definition.backgrounds;
}
export type VisualBackgroundId = string;
export const visualBackgroundIds = Object.values(visualThemes).flatMap((theme) =>
  "backgrounds" in theme ? Object.keys(theme.backgrounds) : [],
);
export function resolveVisualBackground(theme: unknown, value: unknown): string | undefined {
  const definition: VisualThemeDefinition = visualThemes[resolveVisualTheme(theme)];
  if (!definition.backgrounds) return undefined;
  return typeof value === "string" && Object.hasOwn(definition.backgrounds, value)
    ? value
    : definition.defaultBackground;
}
export function normalizeVisualBackground(value: unknown): string {
  const fallback =
    Object.values(visualThemes).find((theme) => "defaultBackground" in theme)?.defaultBackground ??
    "";
  return typeof value === "string" && visualBackgroundIds.includes(value) ? value : fallback;
}
export function resolveVisualTheme(value: unknown): VisualThemeId {
  return typeof value === "string" && Object.hasOwn(visualThemes, value)
    ? (value as VisualThemeId)
    : "original";
}
