import type { Viewport } from "next";

export interface ThemeColorEntry {
  media?: string;
  color: string;
}

function isThemeColorEntry(
  value: string | ThemeColorEntry,
): value is ThemeColorEntry {
  return typeof value === "object" && value !== null && "color" in value;
}

/**
 * Normalizes the viewport themeColor (string, single descriptor, or array)
 * into descriptor entries, shared by the metadata and theme tests so the
 * normalization logic lives in exactly one place.
 */
export function themeColorEntries(viewport: Viewport): ThemeColorEntry[] {
  const value = viewport.themeColor;
  if (Array.isArray(value)) {
    return value.filter(isThemeColorEntry);
  }
  return value && isThemeColorEntry(value) ? [value] : [];
}
