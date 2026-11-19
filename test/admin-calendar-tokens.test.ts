import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Admin calendar V2 tokens (spec 008 T004, DESIGN.md §3-4, UX-22): the pairs
// DESIGN.md §3 assigns keep WCAG 2.x contrast in light and dark, including text
// on the glass that floats over the scrolling grid, whatever block is beneath.
// T005 adds the now line and block-edge pairs once it decides how they are drawn.

type Rgba = [number, number, number, number];
type Theme = "light" | "dark";

const css = readFileSync("public/glass-tokens.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
// Token values count only in the unconditional :root block that opens the file,
// where both stacks read them (not one wrapped in an at-rule).
const root = /^\s*:root\s*\{([^{}]*)\}/.exec(css)?.[1] ?? "";

const parse = (value: string): Rgba => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  throw new Error(`unsupported color: ${value}`);
};

// Light reads --mg-<name>; dark reads --mg-dark-<name>, which is what both
// stacks remap the active aliases to.
const color = (theme: Theme, name: string): Rgba => {
  const token = theme === "light" ? `--mg-${name}` : `--mg-dark-${name}`;
  const match = new RegExp(`(?:^|[{;])\\s*${token}\\s*:\\s*([^;{}]+?)\\s*;`, "m").exec(root);
  if (!match) throw new Error(`${token} is not declared in the :root block of public/glass-tokens.css`);
  return parse(match[1]);
};

const linear = (channel: number) => {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgba) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a: Rgba, b: Rgba) => {
  // Contrast is defined for opaque colors only; translucent ones go through over().
  if (a[3] !== 1 || b[3] !== 1) throw new Error(`contrast needs opaque colors: ${a.join()} / ${b.join()}`);
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

// A translucent fill painted over an opaque backdrop (source-over in sRGB).
const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba => [
  r * a + br * (1 - a),
  g * a + bg * (1 - a),
  b * a + bb * (1 - a),
  1
];

// The glass classes also run saturate() on the backdrop (Filter Effects 1
// matrix, clamped). Read each tier's amount from the stylesheet so a change to
// one tier is checked against that tier.
const saturation = (tier: string) =>
  Number(new RegExp(`\\.${tier}\\s*\\{[^}]*saturate\\(([\\d.]+)\\)`).exec(css)?.[1]);
const saturate = ([r, g, b]: Rgba, s: number): Rgba => {
  const clamp = (v: number) => Math.min(255, Math.max(0, v));
  return [
    clamp((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b),
    1
  ];
};

const TEXT = 4.5; // WCAG 1.4.3
const UI = 3; // WCAG 1.4.11: outlines, focus rings, icons, the today circle

// DESIGN.md §3 roles. The grid line is a supporting divider and is not here.
const OPAQUE_PAIRS: Array<[string, string, number]> = [
  ["cal-text", "cal-outer", TEXT],
  ["cal-text", "cal-surface", TEXT],
  ["cal-text", "cal-detail", TEXT],
  ["cal-text-secondary", "cal-outer", TEXT],
  ["cal-text-secondary", "cal-surface", TEXT],
  ["cal-text-secondary", "cal-detail", TEXT],
  ["cal-primary", "cal-outer", TEXT],
  ["cal-primary", "cal-surface", TEXT],
  ["cal-primary", "cal-detail", TEXT],
  ["cal-on-primary", "cal-primary", TEXT],
  ["cal-on-selected", "cal-selected", TEXT],
  ["cal-on-confirmed", "cal-confirmed", TEXT],
  ["cal-on-pending", "cal-pending", TEXT],
  ["cal-on-external", "cal-external", TEXT],
  ["cal-alert", "cal-outer", TEXT],
  ["cal-alert", "cal-surface", TEXT],
  ["cal-alert", "cal-detail", TEXT],
  ["cal-outline", "cal-outer", UI],
  ["cal-outline", "cal-surface", UI],
  ["cal-outline", "cal-detail", UI]
];

// Everything that can scroll beneath the floating glass.
const BACKDROPS = [
  "cal-surface",
  "cal-outer",
  "cal-confirmed",
  "cal-pending",
  "cal-external",
  "cal-primary",
  "cal-selected"
];

// The floating parts (DESIGN.md §3: blur only on these), their material tier,
// and the colors allowed on each. Text sitting directly on the bar's glass is
// body color only (text on a primary fill, such as today's date, uses
// cal-on-primary, an opaque pair checked above): cal-text-secondary and
// cal-primary text fall below 4.5:1 on the glass over a block (light: about
// 3.9 and 4.1), so primary appears on the bar only as a fill, an icon or a
// focus ring. cal-outline may sit on the bar but never as a control's only
// cue: it falls to about 2.9:1 (light) and 2.4:1 (dark) on the glass over a
// block, so bar controls are told apart by their text or icon (DESIGN.md §3).
const GLASS: Array<{ part: string; tier: string; colors: Array<[string, number]> }> = [
  { part: "top bar", tier: "glass-thick", colors: [["cal-text", TEXT], ["cal-primary", UI]] },
  { part: "add button", tier: "glass-thick", colors: [["cal-primary", UI]] },
  {
    part: "details",
    tier: "glass-modal",
    colors: [
      ["cal-text", TEXT],
      ["cal-text-secondary", TEXT],
      ["cal-primary", TEXT],
      ["cal-alert", TEXT],
      ["cal-outline", UI]
    ]
  }
];

describe("admin calendar V2 tokens", () => {
  it("measures contrast with the WCAG formula", () => {
    expect(contrast([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5);
    expect(contrast(parse("#FFFFFF"), parse("#1A73E8"))).toBeCloseTo(4.505, 3);
    expect(() => contrast(parse("rgba(60, 64, 67, 0)"), parse("#FFFFFF"))).toThrow(/opaque/);
    expect(over([255, 255, 255, 0.5], [0, 0, 0, 1])).toEqual([127.5, 127.5, 127.5, 1]);
    for (const { tier } of GLASS) expect(saturation(tier), tier).toBeGreaterThan(0);
    // Grey has no saturation to boost; saturate(1) changes nothing; saturate(0)
    // collapses a color to its luma (0.213 R + 0.715 G + 0.072 B).
    expect(saturate([128, 128, 128, 1], 1.8).map(Math.round)).toEqual([128, 128, 128, 1]);
    expect(saturate([26, 115, 232, 1], 1).map(Math.round)).toEqual([26, 115, 232, 1]);
    expect(saturate([255, 0, 0, 1], 0).map((v) => Number(v.toFixed(3)))).toEqual([54.315, 54.315, 54.315, 1]);
  });

  for (const theme of ["light", "dark"] as const) {
    it(`keeps every opaque pair readable (${theme})`, () => {
      for (const [fg, bg, min] of OPAQUE_PAIRS) {
        expect(contrast(color(theme, fg), color(theme, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
      }
    });

    it(`keeps the floating glass readable over anything beneath it (${theme})`, () => {
      for (const { part, tier, colors } of GLASS) {
        const glass = color(theme, `${tier}-bg`);
        for (const backdrop of BACKDROPS) {
          const fill = color(theme, backdrop);
          for (const beneath of [fill, saturate(fill, saturation(tier))]) {
            const face = over(glass, beneath);
            for (const [fg, min] of colors) {
              expect(contrast(color(theme, fg), face), `${part}: ${fg} over ${backdrop}`).toBeGreaterThanOrEqual(min);
            }
          }
        }
        // Reduced transparency and increased contrast swap the glass for the
        // opaque elevated paper (public/glass-tokens.css media blocks).
        for (const [fg, min] of colors) {
          const fallback = color(theme, "paper-elevated");
          expect(contrast(color(theme, fg), fallback), `${part}: ${fg} without glass`).toBeGreaterThanOrEqual(min);
        }
      }
    });
  }
});
