import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { viewport } from "./metadata";
import { themeColorEntries } from "./testing/theme-colors";

/**
 * Mechanical UI-contract tests for the product theme and responsive rules.
 * The stylesheet itself is the source of truth: tokens are parsed out of
 * globals.css, so the contrast math verifies the real shipped values, and
 * the touch-target, reflow, focus, and page-shell rules are checked in the
 * same file. Truly visual checks (real viewport rendering, zoom, theme
 * switching) are documented in docs/responsive-ui.md and belong to the
 * browser suite.
 */

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

interface ThemeToken {
  light: string;
  dark: string;
}

/** Parses the :root token block, where every color is a light-dark pair. */
function themeTokens(): Map<string, ThemeToken> {
  const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const tokens = new Map<string, ThemeToken>();
  for (const match of rootBlock.matchAll(
    /--([a-z0-9-]+):\s*light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\)/g,
  )) {
    tokens.set(match[1], { light: match[2], dark: match[3] });
  }
  return tokens;
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  );
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [
    relativeLuminance(first),
    relativeLuminance(second),
  ].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const REQUIRED_TOKENS = [
  "background",
  "foreground",
  "muted",
  "border",
  "surface",
  "accent",
  "accent-foreground",
  "danger",
  "danger-foreground",
  "supporter",
  "supporter-foreground",
  "opponent",
  "opponent-foreground",
  "success",
  "warning",
  "error",
  "focus",
] as const;

describe("semantic theme tokens", () => {
  const tokens = themeTokens();

  it("defines every required token as a light-dark pair", () => {
    for (const name of REQUIRED_TOKENS) {
      expect(tokens.get(name), `missing token --${name}`).toBeDefined();
    }
  });

  it.each(["light", "dark"] as const)(
    "meets WCAG AA for text, status, controls, and focus in the %s theme",
    (theme) => {
      const token = (name: string) => tokens.get(name)![theme];
      const background = token("background");
      const surface = token("surface");

      // Body and secondary text (WCAG 1.4.3: 4.5:1).
      expect(contrastRatio(token("foreground"), background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(token("muted"), background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(token("foreground"), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(token("muted"), surface)).toBeGreaterThanOrEqual(4.5);

      // Status text on the page background (WCAG 1.4.3).
      expect(contrastRatio(token("success"), background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(token("warning"), background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(token("error"), background)).toBeGreaterThanOrEqual(4.5);

      // Filled controls and both Speaker treatments (WCAG 1.4.3).
      expect(contrastRatio(token("accent"), token("accent-foreground"))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(token("danger"), token("danger-foreground"))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(token("supporter"), token("supporter-foreground"))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(token("opponent"), token("opponent-foreground"))).toBeGreaterThanOrEqual(4.5);

      // Boundaries and focus indicators (WCAG 1.4.11 / 2.4.11: 3:1).
      expect(contrastRatio(token("border"), background)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(token("border"), surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(token("focus"), background)).toBeGreaterThanOrEqual(3);
    },
  );

  it("keeps the source theme token-driven with no per-scheme media queries", () => {
    // The source stylesheet carries no per-scheme rules: light-dark() pairs
    // on :root handle both themes. The build toolchain may polyfill
    // light-dark() into its own prefers-color-scheme rule in the compiled
    // artifact; token resolution is what this suite guards.
    expect(css).not.toMatch(/prefers-color-scheme/);
  });

  it("keeps browser chrome metadata in sync with the background tokens", () => {
    const themeColors = themeColorEntries(viewport);
    const light = themeColors.find((entry) => entry.media?.includes("light"));
    const dark = themeColors.find((entry) => entry.media?.includes("dark"));
    expect(light?.color.toLowerCase()).toBe(tokens.get("background")!.light);
    expect(dark?.color.toLowerCase()).toBe(tokens.get("background")!.dark);
  });
});

function ruleFor(selector: string): string {
  return css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("responsive and touch contracts", () => {
  it("keeps interactive controls on a minimum 44px touch target", () => {
    const rule = ruleFor("\\.control(?!-)");
    expect(rule).toMatch(/min-height:\s*44px/);
    expect(rule).toMatch(/min-width:\s*44px/);
  });

  it("spans primary controls on narrow screens and returns to content width at the sm breakpoint", () => {
    const block = ruleFor("\\.control-block");
    expect(block).toMatch(/width:\s*100%/);

    const media = css.match(/@media\s*\(min-width:\s*40rem\)\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(media).toContain(".control-block");
    expect(media).toMatch(/width:\s*auto/);
  });

  it("reflows long Topics and Messages instead of overflowing the viewport", () => {
    const rule = ruleFor("\\.reflow");
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("bounds the page shell width with no minimum width", () => {
    const rule = ruleFor("\\.page-shell");
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/max-width:\s*56rem/);
    expect(rule).toMatch(/margin-inline:\s*auto/);
    expect(rule).not.toMatch(/min-width/);
  });

  it("provides a visible focus indicator using the focus token", () => {
    const rule = ruleFor(":focus-visible");
    expect(rule).toMatch(/outline:\s*2px\s+solid\s+var\(--focus\)/);
    expect(rule).toMatch(/outline-offset:\s*2px/);
  });
});
