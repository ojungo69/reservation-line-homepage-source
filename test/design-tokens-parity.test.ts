import { existsSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Contract: specs/002-monotone-glass/contracts/design-token-contract.md
// Method ported from 001 (feat/liquid-glass-design:8b2b600). Regex-based static
// parsing — the shared CSS must stay nesting-free for ruleBody() to work.

const sharedPath = "public/glass-tokens.css";
const sharedCss = existsSync(sharedPath) ? readFileSync(sharedPath, "utf8") : "";
const publicCss = readFileSync("public/styles.css", "utf8");
const publicHtml = readFileSync("public/index.html", "utf8");
const publicApp = readFileSync("public/app.js", "utf8");
const legalPages = ["cancellation", "notice", "privacy", "terms", "tokusho"].map((name) => ({
  name,
  html: readFileSync(`public/legal/${name}.html`, "utf8")
}));
const customerJs = readFileSync("public/customer/reservations.js", "utf8");
const customerSsr = readFileSync("src/customer/reservations-page.ts", "utf8");
const adminCss = readFileSync("admin-app/src/index.css", "utf8");
// Contract items 9/13 (PR-G2): the whole admin source tree is a consumer.
const adminSourceFiles = (() => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx|css)$/.test(entry.name)) files.push(path);
    }
  };
  walk("admin-app/src");
  return files.sort().map((path) => ({ path, source: readFileSync(path, "utf8") }));
})();

const ruleBody = (source: string, selector: string) => {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`${escapedSelector}\\s*\\{([^{}]*)\\}`))?.[1] ?? "";
};

/* ── Detectors (contract item 9: scan contexts are file-type specific) ── */

const stripCssComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "");
// Same, but comment bodies become spaces so match indices keep pointing at the
// original source (needed for the position-sensitive dark-block check).
const blankCssComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));
const stripJsComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, "$1");

/* Face-property guard: rules targeting material-carrying elements must leave
   background/border/shadow/filter to the material layer (narrow allowlist). */
// Every background-* and border-* longhand (style/width/color/image alike) is
// the same face via another name — only the radius family is geometry.
const FACE_PROP =
  /^(?:background[a-z-]*|border(?![a-z-]*radius)[a-z-]*|box-shadow|backdrop-filter|-webkit-backdrop-filter|filter)$/;
const MATERIAL_KEYS = [
  ".reservation-panel",
  ".step-progress",
  ".services-popover",
  ".panel",
  "#status-banner",
  ".legal-shell"
];
const FACE_ALLOWED: Array<{ key: string; prelude: RegExp; props: string[] }> = [
  // Intentional depth override — shadows are untouched by the a11y modes.
  { key: ".reservation-panel", prelude: /^\.reservation-panel$/, props: ["box-shadow"] },
  // Semantic state tint on the status banner border only.
  { key: "#status-banner", prelude: /#status-banner\[data-tone=/, props: ["border-color"] },
  // Arch-approved: only the bottom hairline of the sticky step bar shows; the
  // glass-thin material still owns the border color.
  { key: ".step-progress", prelude: /^\.step-progress$/, props: ["border-width"] }
];
const faceViolations = (css: string) => {
  const violations: string[] = [];
  // [^{}] block parsing skips at-rule headers and matches the inner rules,
  // so @media-wrapped overrides are still scanned.
  for (const rule of stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = rule[1].trim();
    for (const compound of prelude.split(",")) {
      // The key (rightmost) compound selector decides which element the rule
      // styles — descendants of a material element are someone else's face.
      const key = compound.trim().split(/\s+/).pop() ?? "";
      const materialKey = MATERIAL_KEYS.find((k) =>
        new RegExp(`${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(key)
      );
      if (!materialKey) continue;
      const allowed = FACE_ALLOWED.filter(
        (entry) => entry.key === materialKey && entry.prelude.test(compound.trim())
      ).flatMap((entry) => entry.props);
      for (const declaration of rule[2].split(";")) {
        // Lowercased: CSS property names are case-insensitive (`BACKGROUND:`).
        const property = declaration.split(":")[0]?.trim().toLowerCase() ?? "";
        if (FACE_PROP.test(property) && !allowed.includes(property)) {
          violations.push(`${compound.trim()} → ${property}`);
        }
      }
    }
  }
  return violations;
};

// Case-insensitive: CSS color syntax is case-insensitive (`RGB(...)`, `#FFF`).
const COLOR_FUNCTION = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch|color|color-mix|device-cmyk|light-dark)\(/i;
// CSS named colors and system colors are forbidden; transparent/currentColor/
// inherit/none are the only intentional keywords (contract item 9). The named
// list is the full CSS Color 4 <named-color> set plus <system-color>.
const NAMED_COLOR =
  /\b(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen|accentcolor|accentcolortext|activetext|buttonborder|buttonface|buttontext|canvas|canvastext|field|fieldtext|graytext|highlight|highlighttext|linktext|mark|marktext|selecteditem|selecteditemtext|visitedtext|activeborder|activecaption|appworkspace|background|buttonhighlight|buttonshadow|captiontext|inactiveborder|inactivecaption|inactivecaptiontext|infobackground|infotext|menu|menutext|scrollbar|threeddarkshadow|threedface|threedhighlight|threedlightshadow|threedshadow|window|windowframe|windowtext)\b/i;
const RAW_EFFECT = /\b(?:linear-gradient|radial-gradient|conic-gradient|cubic-bezier|blur|saturate)\(/i;

// `-` is a word boundary, so `\bfield\b` would match inside `--radius-field`
// and `\bbackground\b` inside a `transition: background-color …` value — drop
// custom properties and hyphen-joined identifiers before the named-color test
// (every CSS named/system color is a single unhyphenated word).
const withoutCustomIdents = (value: string) =>
  value.replace(/--[a-zA-Z0-9-]+/g, "").replace(/[a-zA-Z]+(?:-[a-zA-Z]+)+/g, "");
const rawColorIn = (value: string) =>
  COLOR_FUNCTION.test(value) || NAMED_COLOR.test(withoutCustomIdents(value)) || RAW_EFFECT.test(value);

/** CSS scan context: declaration values only (comments stripped). */
const cssValueViolations = (source: string) => {
  const violations: string[] = [];
  for (const match of stripCssComments(source).matchAll(/([a-zA-Z-]{2}[a-zA-Z-]*)\s*:\s*([^;{}]+)[;}]/g)) {
    const value = match[2].trim();
    if (rawColorIn(value)) violations.push(`${match[1]}: ${value}`);
  }
  return violations;
};

/** HTML scan context: style attributes, <style> blocks, and the theme-color allowlist. */
const APPROVED_THEME_COLORS = new Set(["#FAFAFA", "#111111"]);
// HTML-spec attribute extraction: names are case-insensitive, values may be
// double-quoted, single-quoted, or unquoted (`<DIV STYLE=color:red>`).
const attrValue = (tag: string, name: string) => {
  const match = tag.match(new RegExp(`[\\s"']${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[2] ?? match[3] ?? match[4] ?? "") : null;
};
const themeColorMetas = (source: string) => {
  const metas: Array<{ content: string; media: string }> = [];
  for (const tag of source.matchAll(/<meta\b[^>]*>/gi)) {
    if ((attrValue(tag[0], "name") ?? "").toLowerCase() !== "theme-color") continue;
    metas.push({ content: attrValue(tag[0], "content") ?? "", media: attrValue(tag[0], "media") ?? "" });
  }
  return metas;
};
const htmlViolations = (source: string) => {
  const violations: string[] = [];
  for (const tag of source.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const style = attrValue(tag[0], "style");
    if (style !== null && rawColorIn(style)) violations.push(`style attribute: ${style}`);
  }
  for (const match of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    violations.push(...cssValueViolations(match[1]));
  }
  for (const meta of themeColorMetas(source)) {
    if (!APPROVED_THEME_COLORS.has(meta.content)) violations.push(`theme-color: ${meta.content}`);
  }
  return violations;
};

/** JS/TS scan context: inline-style writes via the four DOM mutation constructs. */
const jsViolations = (source: string) => {
  const stripped = stripJsComments(source);
  const violations: string[] = [];
  const constructs: [string, RegExp][] = [
    ["style property", /\.style\.(?!cssText)[a-zA-Z]+\s*=\s*(["'`])((?:(?!\1).)*)\1/g],
    ["style.setProperty", /\.setProperty\(\s*(["'`])(?:(?!\1).)*\1\s*,\s*(["'`])((?:(?!\2).)*)\2/g],
    ["style.cssText", /\.cssText\s*=\s*(["'`])((?:(?!\1).)*)\1/g],
    ["setAttribute style", /setAttribute\(\s*(["'`])style\1\s*,\s*(["'`])((?:(?!\2).)*)\2/g]
  ];
  for (const [label, pattern] of constructs) {
    for (const match of stripped.matchAll(pattern)) {
      const value = match[3] ?? match[2];
      if (rawColorIn(value)) violations.push(`${label}: ${value}`);
    }
  }
  return violations;
};

/* ── Contract token table (single source for value pins and reference allowlists) ── */
const EXPECTED_TOKEN_VALUES: Array<[string, string]> = [
["--mg-paper", "#FAFAFA"],
["--mg-paper-elevated", "#FFFFFF"],
["--mg-ink", "#111111"],
["--mg-ink-secondary", "#6E6E73"],
["--mg-ink-secondary-strong", "#55555B"],
["--mg-ink-disabled", "#C7C7CC"],
["--mg-on-ink", "#FFFFFF"],
["--mg-hairline", "#E5E5EA"],
["--mg-fill-subtle", "#F2F2F4"],
["--mg-glass-thick-bg", "rgba(255, 255, 255, 0.72)"],
["--mg-glass-thick-border", "rgba(17, 17, 17, 0.07)"],
["--mg-glass-thick-shadow", "0 8px 40px rgba(0, 0, 0, 0.10)"],
["--mg-glass-thick-blur", "24px"],
["--mg-glass-mid-bg", "rgba(255, 255, 255, 0.60)"],
["--mg-glass-mid-border", "rgba(17, 17, 17, 0.06)"],
["--mg-glass-mid-shadow", "0 4px 24px rgba(0, 0, 0, 0.08)"],
["--mg-glass-mid-blur", "16px"],
["--mg-glass-thin-bg", "rgba(255, 255, 255, 0.45)"],
["--mg-glass-thin-border", "rgba(17, 17, 17, 0.05)"],
["--mg-glass-thin-shadow", "0 2px 12px rgba(0, 0, 0, 0.06)"],
["--mg-glass-thin-blur", "10px"],
["--mg-glass-modal-bg", "rgba(255, 255, 255, 0.95)"],
["--mg-scrim", "rgba(0, 0, 0, 0.80)"],
["--mg-error", "#C62828"],
["--mg-success", "#1B7A3D"],
["--mg-warning", "#8A5A00"],
["--mg-line", "#0A7D3A"],
["--mg-line-text", "#FFFFFF"],
["--mg-verified", "#066B30"],
["--mg-radius-phone", "24px"],
["--mg-radius-card", "12px"],
["--mg-radius-field", "10px"],
["--mg-radius-btn", "12px"],
["--mg-radius-chip", "20px"],
["--mg-radius-slot", "8px"],
["--mg-radius-logo", "10px"],
["--mg-motion-fast", "120ms"],
["--mg-motion-base", "260ms"],
["--mg-ease-out", "cubic-bezier(0.2, 0, 0, 1)"],
["--mg-ease-spring", "cubic-bezier(0.34, 1.56, 0.64, 1)"],
["--mg-font-input", "16px"],
["--mg-font-min", "12px"],
["--mg-touch-target", "48px"],
["--mg-touch-min", "44px"],
["--mg-dark-paper", "#111111"],
["--mg-dark-paper-elevated", "#1C1C1E"],
["--mg-dark-ink", "#F0F0F0"],
["--mg-dark-ink-secondary", "#A1A1A6"],
["--mg-dark-ink-secondary-strong", "#B8B8B8"],
["--mg-dark-ink-disabled", "#48484A"],
["--mg-dark-on-ink", "#111111"],
["--mg-dark-hairline", "#2C2C2E"],
["--mg-dark-fill-subtle", "#1A1A1A"],
["--mg-dark-glass-thick-bg", "rgba(28, 28, 30, 0.72)"],
["--mg-dark-glass-thick-border", "rgba(255, 255, 255, 0.08)"],
["--mg-dark-glass-thick-shadow", "0 8px 40px rgba(0, 0, 0, 0.50)"],
["--mg-dark-glass-mid-bg", "rgba(28, 28, 30, 0.60)"],
["--mg-dark-glass-mid-border", "rgba(255, 255, 255, 0.07)"],
["--mg-dark-glass-mid-shadow", "0 4px 24px rgba(0, 0, 0, 0.40)"],
["--mg-dark-glass-thin-bg", "rgba(28, 28, 30, 0.45)"],
["--mg-dark-glass-thin-border", "rgba(255, 255, 255, 0.06)"],
["--mg-dark-glass-thin-shadow", "0 2px 12px rgba(0, 0, 0, 0.30)"],
["--mg-dark-glass-modal-bg", "rgba(28, 28, 30, 0.95)"],
["--mg-dark-error", "#FF6B6B"],
["--mg-dark-success", "#4CD07A"],
["--mg-dark-warning", "#D6A13A"],
["--mg-active-paper", "var(--mg-paper)"],
["--mg-active-paper-elevated", "var(--mg-paper-elevated)"],
["--mg-active-ink", "var(--mg-ink)"],
["--mg-active-ink-secondary", "var(--mg-ink-secondary)"],
["--mg-active-ink-secondary-strong", "var(--mg-ink-secondary-strong)"],
["--mg-active-ink-disabled", "var(--mg-ink-disabled)"],
["--mg-active-on-ink", "var(--mg-on-ink)"],
["--mg-active-hairline", "var(--mg-hairline)"],
["--mg-active-fill-subtle", "var(--mg-fill-subtle)"],
["--mg-active-glass-thick-bg", "var(--mg-glass-thick-bg)"],
["--mg-active-glass-thick-border", "var(--mg-glass-thick-border)"],
["--mg-active-glass-thick-shadow", "var(--mg-glass-thick-shadow)"],
["--mg-active-glass-mid-bg", "var(--mg-glass-mid-bg)"],
["--mg-active-glass-mid-border", "var(--mg-glass-mid-border)"],
["--mg-active-glass-mid-shadow", "var(--mg-glass-mid-shadow)"],
["--mg-active-glass-thin-bg", "var(--mg-glass-thin-bg)"],
["--mg-active-glass-thin-border", "var(--mg-glass-thin-border)"],
["--mg-active-glass-thin-shadow", "var(--mg-glass-thin-shadow)"],
["--mg-active-glass-modal-bg", "var(--mg-glass-modal-bg)"],
["--mg-active-scrim", "var(--mg-scrim)"],
["--mg-active-error", "var(--mg-error)"],
["--mg-active-success", "var(--mg-success)"],
["--mg-active-warning", "var(--mg-warning)"],
["--mg-active-line", "var(--mg-line)"],
["--mg-active-line-text", "var(--mg-line-text)"],
["--mg-active-verified", "var(--mg-verified)"]
];

/* ── Detector self-test (contract item 9: false-positive regression fixture) ── */

describe("consumer raw-value detectors", () => {
  it("does not misread HTML entities, comments, or issue numbers as colors", () => {
    expect(htmlViolations('<div class="success-icon">&#10003;</div>')).toEqual([]);
    expect(jsViolations('// see issue #467 and PR #531\nconst x = "checkmark &#10003;";')).toEqual([]);
    expect(cssValueViolations("/* accent was #116149 */ color: var(--mg-active-ink);")).toEqual([]);
  });

  it("accepts only the approved theme-color values", () => {
    expect(htmlViolations('<meta name="theme-color" content="#FAFAFA" />')).toEqual([]);
    expect(htmlViolations('<meta name="theme-color" content="#ffffff" />')).toHaveLength(1);
  });

  it("flags raw colors in each DOM style mutation construct", () => {
    expect(jsViolations('el.style.color = "#123456";')).toHaveLength(1);
    expect(jsViolations('el.style.setProperty("--x", "rgb(1, 2, 3)");')).toHaveLength(1);
    expect(jsViolations('el.style.cssText = "background: oklch(0.5 0.1 200)";')).toHaveLength(1);
    expect(jsViolations('el.setAttribute("style", "color: red");')).toHaveLength(1);
  });

  it("flags raw colors, named colors, and raw effects in CSS declaration values", () => {
    expect(cssValueViolations("border: solid #ffffff;")).toHaveLength(1);
    expect(cssValueViolations("color: red;")).toHaveLength(1);
    expect(cssValueViolations("transition: all 200ms cubic-bezier(0.2, 0, 0, 1);")).toHaveLength(1);
    expect(cssValueViolations("color: transparent; outline: none;")).toEqual([]);
  });

  it("flags case variants, extended named/system colors, and attr-order metas", () => {
    expect(cssValueViolations("background: RGB(1, 2, 3);")).toHaveLength(1);
    expect(cssValueViolations("color: rebeccapurple;")).toHaveLength(1);
    expect(cssValueViolations("color: Canvas;")).toHaveLength(1);
    expect(cssValueViolations("border: 1px solid #FFF;")).toHaveLength(1);
    // CSS Color 4 Appendix A deprecated system colors are still UA-supported.
    expect(cssValueViolations("color: WindowText;")).toHaveLength(1);
    expect(cssValueViolations("border-color: ActiveBorder;")).toHaveLength(1);
    expect(htmlViolations('<meta content="#ff0000" name="theme-color" />')).toHaveLength(1);
    expect(htmlViolations("<meta content='#FAFAFA' name='theme-color' />")).toEqual([]);
    // HTML-spec forms: unquoted values and case-variant attribute names.
    expect(htmlViolations("<meta name=theme-color content=#ff0000>")).toHaveLength(1);
    expect(htmlViolations('<DIV STYLE="color:red">')).toHaveLength(1);
    expect(htmlViolations("<div style=color:red>")).toHaveLength(1);
  });
});

/* ── Shared token source (contract items 1-4) ── */

describe("Monotone Liquid Glass shared token contract", () => {
  it("has one shared stylesheet", () => {
    expect(existsSync(sharedPath), `${sharedPath} must be the shared token source`).toBe(true);
  });

  it("declares exactly the contract token set with the approved values, each exactly once", () => {
    // FR-010 / SC-006: EVERY token is value-pinned (not a sample), and the scan
    // runs on comment-stripped CSS so a declaration moved into a comment reads
    // as deleted, not as still present.
    const stripped = stripCssComments(sharedCss);
    const counts = new Map<string, number>();
    const values = new Map<string, string>();
    for (const match of stripped.matchAll(/(?:^|[{;])\s*(--mg-[a-z0-9-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/gm)) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
      values.set(match[1], match[2].trim());
    }
    for (const [token, value] of EXPECTED_TOKEN_VALUES) {
      expect(counts.get(token) ?? 0, `${token} declared ${counts.get(token) ?? 0} times`).toBe(1);
      expect(values.get(token), `${token} value drifted`).toBe(value);
    }
    const expectedNames = new Set(EXPECTED_TOKEN_VALUES.map(([token]) => token));
    const unexpected = [...counts.keys()].filter((token) => !expectedNames.has(token));
    expect(unexpected, `tokens not in the contract set: ${unexpected.join(", ")}`).toEqual([]);
    // Comment-hiding red fixture: a commented-out declaration must not count.
    const hidden = new Map<string, number>();
    for (const match of stripCssComments("/* --mg-paper: #000000; */").matchAll(/(--mg-[a-z0-9-]+)\s*:/g)) {
      hidden.set(match[1], (hidden.get(match[1]) ?? 0) + 1);
    }
    expect(hidden.size).toBe(0);
    // Semicolon-less red fixture: CSS allows omitting the final semicolon, so
    // `:root { --mg-paper: #000 }` must still be seen (and bump the count).
    const semicolonless = [
      ...":root { --mg-paper: #000 }".matchAll(/(?:^|[{;])\s*(--mg-[a-z0-9-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/gm)
    ];
    expect(semicolonless.map((match) => [match[1], match[2].trim()])).toEqual([["--mg-paper", "#000"]]);
  });

  it("contains no purple accents, chromatic gradients, or ambient washes (001 must not leak in)", () => {
    for (const source of [sharedCss, publicCss, publicHtml, publicApp, customerJs, customerSsr, adminCss]) {
      const lowered = source.toLowerCase();
      for (const banned of ["#574ce0", "#4238c4", "#a79bff", "radial-gradient(", "conic-gradient("]) {
        expect(lowered, `banned 001 value present: ${banned}`).not.toContain(banned);
      }
    }
  });


  it("defines each material base as an opaque active-token tuple with no blur", () => {
    const materials = [
      ["surface", "thin"],
      ["glass-thick", "thick"],
      ["glass-mid", "mid"],
      ["glass-thin", "thin"],
      // Modal glass reuses thick's border/shadow/blur; only its fill differs.
      ["glass-modal", "thick"]
    ] as const;
    for (const [className, tuple] of materials) {
      const rule = ruleBody(sharedCss, `.${className}`);
      expect(rule, `missing .${className}`).not.toBe("");
      expect(rule).toContain("background: var(--mg-active-paper-elevated);");
      expect(rule).toContain(`box-shadow: var(--mg-active-glass-${tuple}-shadow);`);
      expect(rule).toContain("-webkit-backdrop-filter: none;");
      expect(rule).toMatch(/(?:^|\n)\s*backdrop-filter: none;/);
    }
    expect(ruleBody(sharedCss, ".surface")).toContain("border: 1px solid var(--mg-active-hairline);");
    for (const tuple of ["thick", "mid", "thin"] as const) {
      expect(ruleBody(sharedCss, `.glass-${tuple}`)).toContain(
        `border: 1px solid var(--mg-active-glass-${tuple}-border);`
      );
    }
  });

  it("enforces the cascade order and confines translucency to @supports", () => {
    const baseIndex = sharedCss.search(/\.glass-thick\s*\{/);
    const supportsIndex = sharedCss.indexOf("@supports ((backdrop-filter: blur(1px))");
    const reducedMotionIndex = sharedCss.indexOf("@media (prefers-reduced-motion: reduce)");
    const reducedTransparencyIndex = sharedCss.indexOf("@media (prefers-reduced-transparency: reduce)");
    const contrastIndex = sharedCss.indexOf("@media (prefers-contrast: more)");

    expect(baseIndex).toBeGreaterThan(-1);
    expect(supportsIndex).toBeGreaterThan(baseIndex);
    expect(reducedMotionIndex).toBeGreaterThan(supportsIndex);
    expect(reducedTransparencyIndex).toBeGreaterThan(reducedMotionIndex);
    expect(contrastIndex).toBeGreaterThan(reducedTransparencyIndex);

    const supportsCss = sharedCss.slice(supportsIndex, reducedMotionIndex);
    for (const tuple of ["thick", "mid", "thin"] as const) {
      const rule = ruleBody(supportsCss, `.glass-${tuple}`);
      expect(rule).toContain(`background: var(--mg-active-glass-${tuple}-bg);`);
      expect(rule).toContain(`-webkit-backdrop-filter: blur(var(--mg-glass-${tuple}-blur)) saturate(1.8);`);
      expect(rule).toMatch(
        new RegExp(`(?:^|\\n)\\s*backdrop-filter: blur\\(var\\(--mg-glass-${tuple}-blur\\)\\) saturate\\(1\\.8\\);`)
      );
    }

    const reducedCss = sharedCss.slice(reducedTransparencyIndex, contrastIndex);
    for (const className of ["glass-thick", "glass-mid", "glass-thin"]) {
      expect(reducedCss).toContain(`.${className}`);
    }
    expect(reducedCss).toContain("background: var(--mg-active-paper-elevated);");
    expect(reducedCss).toContain("-webkit-backdrop-filter: none;");
    expect(reducedCss).toMatch(/(?:^|\n)\s*backdrop-filter: none;/);

    const contrastCss = sharedCss.slice(contrastIndex);
    expect(contrastCss).toContain("border: 1px solid var(--mg-active-ink);");
  });

  it("contains no prefers-color-scheme block (dark remapping belongs to each stack)", () => {
    expect(stripCssComments(sharedCss)).not.toContain("prefers-color-scheme");
  });
});

/* ── Public consumer mapping (contract items 5-7, 9-11) ── */

describe("Monotone Liquid Glass public token mapping", () => {
  it("imports the shared source before all public rules", () => {
    expect(publicCss.trimStart()).toMatch(/^@import "\.\/glass-tokens\.css";/);
  });

  it("maps existing semantic variables to active shared tokens", () => {
    const expectedDeclarations = [
      "--color-bg: var(--mg-active-paper-elevated)",
      "--color-surface: var(--mg-active-paper)",
      "--color-border: var(--mg-active-hairline)",
      "--color-border-focus: var(--mg-active-ink)",
      "--color-text: var(--mg-active-ink)",
      "--color-text-secondary: var(--mg-active-ink-secondary)",
      "--color-text-secondary-strong: var(--mg-active-ink-secondary-strong)",
      "--color-btn-bg: var(--mg-active-ink)",
      "--color-btn-text: var(--mg-active-on-ink)",
      "--color-btn-outline-bg: var(--mg-active-paper-elevated)",
      "--color-btn-outline-border: var(--mg-active-hairline)",
      "--color-slot-selected-bg: var(--mg-active-ink)",
      "--color-slot-selected-text: var(--mg-active-on-ink)",
      "--color-slot-unavailable-bg: var(--mg-active-fill-subtle)",
      "--color-slot-unavailable-text: var(--mg-active-ink-disabled)",
      "--color-step-active-bg: var(--mg-active-ink)",
      "--color-step-done-bg: var(--mg-active-ink)",
      "--color-step-inactive-bg: var(--mg-active-fill-subtle)",
      "--color-step-inactive-text: var(--mg-active-ink-secondary-strong)",
      "--color-chip-selected-border: var(--mg-active-ink)",
      // FR-004: selected menu chips are ink-filled with on-ink text.
      "--color-chip-selected-bg: var(--mg-active-ink)",
      "--color-chip-selected-text: var(--mg-active-on-ink)",
      "--color-error: var(--mg-active-error)",
      "--color-success: var(--mg-active-success)",
      "--color-warning: var(--mg-active-warning)",
      "--color-line: var(--mg-active-line)",
      "--color-line-text: var(--mg-active-line-text)",
      "--color-verified: var(--mg-active-verified)",
      "--radius-phone: var(--mg-radius-phone)",
      "--radius-field: var(--mg-radius-field)",
      "--radius-btn: var(--mg-radius-btn)",
      "--radius-chip: var(--mg-radius-chip)",
      "--radius-logo: var(--mg-radius-logo)",
      "--radius-slot: var(--mg-radius-slot)",
      "--radius-card: var(--mg-radius-card)",
      "--shadow-phone: var(--mg-active-glass-thick-shadow)"
    ];
    // Exact values, each declared exactly once, and ONLY inside the light
    // :root — a later `:root { --color-text: var(--mg-paper); }` would win the
    // cascade and break dark/AA while a substring check stays green.
    const blanked = blankCssComments(publicCss);
    const lightRoot = blanked.match(/:root\s*\{[^{}]*\}/);
    expect(lightRoot?.index).toBeDefined();
    const lightStart = lightRoot?.index ?? 0;
    const lightEnd = lightStart + (lightRoot?.[0].length ?? 0);
    const expected = new Map(
      expectedDeclarations.map((declaration) => {
        const [name, ...rest] = declaration.split(":");
        return [name.trim(), rest.join(":").trim()] as const;
      })
    );
    const declarations = [
      ...blanked.matchAll(/(?:^|[{;])\s*(--(?:color|radius|shadow)-[a-z0-9-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/gm)
    ];
    for (const [name, value] of expected) {
      const own = declarations.filter((match) => match[1] === name);
      expect(own.length, `${name} declared ${own.length} times`).toBe(1);
      expect(own[0][2].trim(), `${name} value drifted`).toBe(value);
      const at = own[0].index ?? 0;
      expect(at >= lightStart && at < lightEnd, `${name} declared outside the light :root`).toBe(true);
    }
    const unexpected = declarations.map((match) => match[1]).filter((name) => !expected.has(name));
    expect(unexpected, `semantic tokens outside the contract: ${unexpected.join(", ")}`).toEqual([]);

    // Consumers may reference shared tokens only through the active aliases or
    // the non-color scales — a direct var(--mg-ink) would bypass the dark
    // remap. var(--mg-dark-*) is legal only inside the OS-dark remap block.
    // The allowlist is derived from the 87-token contract table by EXACT name,
    // so a typo like var(--mg-active-typo) or var(--mg-motion-fats) is caught
    // (a prefix rule would let it fall back to nothing at runtime unnoticed).
    const tokenNames = new Set(EXPECTED_TOKEN_VALUES.map(([token]) => token));
    const REF_FAMILY =
      /^--mg-(?:active-|motion-|ease-|radius-|font-|touch-|glass-(?:thick|mid|thin)-blur$)/;
    const sharedRefViolations = (css: string) => {
      const source = blankCssComments(css);
      const dark = source.match(
        /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root\s*\{[\s\S]*?\}\s*\}/
      );
      const darkStart = dark?.index ?? -1;
      const darkEnd = darkStart + (dark?.[0].length ?? 0);
      const violations: string[] = [];
      for (const match of source.matchAll(/var\(\s*(--mg-[a-z0-9-]+)/g)) {
        const name = match[1];
        const at = match.index ?? 0;
        if (tokenNames.has(name) && REF_FAMILY.test(name)) continue;
        if (tokenNames.has(name) && /^--mg-dark-/.test(name) && at >= darkStart && at < darkEnd) continue;
        violations.push(name);
      }
      return violations;
    };
    expect(sharedRefViolations(publicCss)).toEqual([]);
    // Red fixtures: unknown-token typos and base-palette refs are both caught.
    expect(sharedRefViolations("a { color: var(--mg-active-typo); }")).toEqual(["--mg-active-typo"]);
    expect(sharedRefViolations("a { transition: var(--mg-motion-fats); }")).toEqual(["--mg-motion-fats"]);
    expect(sharedRefViolations("a { color: var(--mg-ink); }")).toEqual(["--mg-ink"]);
  });

  it("keeps the chip text wrapper on inherited color (selected-row AA fix)", () => {
    // The field-caption rule (`label > span` → secondary gray) also matches
    // the chip's text wrapper; without `color: inherit` the selected ink fill
    // renders the menu name at 3.7:1 (light) / 2.3:1 (dark) — a real AA
    // violation the 2026-08-02 browser walk caught. Pin the override and the
    // higher-specificity selected-price recolor that depends on it.
    const liveCss = stripCssComments(publicCss);
    const chipSpan = /\.chip span\s*\{[^}]*\}/.exec(liveCss)?.[0] ?? "";
    expect(chipSpan).toMatch(/color:\s*inherit/);
    const selectedPrice = /\.chip\.selected \.service-price\s*\{[^}]*\}/.exec(liveCss)?.[0] ?? "";
    expect(selectedPrice).toMatch(/color:\s*var\(--color-chip-selected-text\)/);
  });

  it("remaps every dark-paired active alias in the OS dark block, and only those", () => {
    const darkRule = publicCss.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root\s*\{[\s\S]*?\}\s*\}/
    )?.[0] ?? "";
    // Derived rule: every --mg-dark-<name> in the shared source must have an
    // --mg-active-<name>: var(--mg-dark-<name>) remap here (contract item 7 —
    // a hand-kept list cannot silently miss a new token). Compared as an EXACT
    // name→value map: extra trailing values (`var(--mg-dark-ink) var(--x)`),
    // out-of-contract aliases (`--mg-active-fake`), and drifted values all
    // fail — a substring presence check would let each of those through.
    const darkNames = [...stripCssComments(sharedCss).matchAll(/--mg-dark-([a-z0-9-]+)\s*:/g)].map(
      (match) => match[1]
    );
    expect(darkNames.length).toBeGreaterThan(0);
    const expectedDarkMap = new Map(
      darkNames.map((name) => [`--mg-active-${name}`, `var(--mg-dark-${name})`] as const)
    );
    const actualDarkMap = new Map<string, string>();
    for (const match of stripCssComments(darkRule).matchAll(
      /(?:^|[{;])\s*(--mg-active-[a-z0-9-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/gm
    )) {
      actualDarkMap.set(match[1], match[2].trim());
    }
    expect(Object.fromEntries(actualDarkMap)).toEqual(Object.fromEntries(expectedDarkMap));
    // Intentional inheritance list: these stay light-valued in dark.
    for (const excluded of ["--mg-active-line:", "--mg-active-line-text:", "--mg-active-verified:"]) {
      expect(darkRule, `${excluded} must not be remapped (AA-safe inheritance)`).not.toContain(excluded);
    }
    // Anti-override: active aliases may be declared ONLY inside this dark
    // block, each exactly once — a later `:root { --mg-active-…: … }` appended
    // to styles.css would silently undo the dark remap while every
    // presence-only check above still passes.
    const blanked = blankCssComments(publicCss);
    const darkMatch = blanked.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root\s*\{[\s\S]*?\}\s*\}/
    );
    expect(darkMatch?.index).toBeDefined();
    const darkStart = darkMatch?.index ?? 0;
    const darkEnd = darkStart + (darkMatch?.[0].length ?? 0);
    const activeCounts = new Map<string, number>();
    for (const match of blanked.matchAll(/(?:^|[{;])\s*(--mg-active-[a-z0-9-]+)\s*:/gm)) {
      const at = match.index ?? 0;
      expect(
        at >= darkStart && at < darkEnd,
        `${match[1]} declared outside the OS-dark block in styles.css`
      ).toBe(true);
      activeCounts.set(match[1], (activeCounts.get(match[1]) ?? 0) + 1);
    }
    for (const [name, count] of activeCounts) {
      expect(count, `${name} declared ${count} times in styles.css`).toBe(1);
    }
  });

  it("applies shared materials to the real public and legal surfaces (item 8)", () => {
    // Fixed application set: the main card, the sticky step bar (the one floating
    // glass surface content scrolls under), the menu popover, and each legal shell.
    for (const markup of [
      'class="reservation-panel surface"',
      'class="step-progress glass-thin"',
      'class="services-popover surface"'
    ]) {
      expect(publicHtml).toContain(markup);
    }
    for (const { name, html } of legalPages) {
      expect(html, `legal/${name}.html missing surface shell`).toContain('class="legal-shell surface"');
    }
    // Legal page hierarchy: paper page background one layer below the elevated
    // .legal-shell.surface card, matching the theme-color pair in both schemes
    // (regression for the elevated-on-elevated collapse).
    expect(ruleBody(stripCssComments(publicCss), ".legal-body")).toContain("background: var(--color-surface);");
    // Customer reservations SSR page: single stylesheet link, no inline styles,
    // and its dynamic/static panels carry the shared material class so the
    // a11y modes (prefers-contrast etc.) in glass-tokens.css reach them.
    expect(customerSsr).toContain('<link rel="stylesheet" href="/styles.css?v=');
    expect(customerSsr).not.toContain("<style>");
    // Attribute order keeps the pre-002 assertion in customer-reservations-page
    // .test.ts byte-identical (dom-api-invariants.md allows no edits there).
    expect(customerSsr).toContain('class="surface" id="status-banner"');
    expect(customerJs).toContain('panel.className = "panel surface"');
  });

  it("keeps material-class rules confined to the shared source with pinned counts", () => {
    const keyOf = (compound: string) => compound.trim().split(/\s+/).pop() ?? "";
    const materialRules = (css: string) => {
      const entries: string[] = [];
      for (const rule of stripCssComments(css).matchAll(/([^{}]+)\{[^{}]*\}/g)) {
        for (const compound of rule[1].trim().split(",")) {
          if (/\.(?:surface|glass-thick|glass-mid|glass-thin|glass-modal)(?![\w-])/.test(keyOf(compound))) {
            entries.push(compound.trim());
          }
        }
      }
      return entries;
    };
    // The shared material rules are pinned as an ORDERED sequence of
    // {prelude, declaration-list} — property names lowercased, VALUES kept
    // verbatim (whitespace-collapsed; custom-property names are
    // case-sensitive so values are not lowercased). This fails on: an extra
    // rule appended after the contrast section, a duplicate/case-variant
    // property appended inside an existing rule (later declaration would win
    // the cascade), a conflicting longhand like background-color, any
    // added/removed/reordered property, and any VALUE drift — e.g. the
    // prefers-contrast background flipping to transparent or the
    // reduced-motion transition-duration growing from 0.01ms to 2s would
    // change the pinned tuple (FR-002/FR-008, contract item 4).
    const materialRuleProps = (css: string) => {
      const entries: Array<{ prelude: string; props: string[] }> = [];
      for (const rule of stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const keys = rule[1].trim().split(",").map((compound) => compound.trim());
        if (!keys.some((k) => /\.(?:surface|glass-thick|glass-mid|glass-thin|glass-modal)(?![\w-])/.test(keyOf(k)))) {
          continue;
        }
        entries.push({
          prelude: rule[1].trim().replace(/\s+/g, " "),
          props: rule[2]
            .split(";")
            .map((declaration) => {
              const [prop, ...valueParts] = declaration.split(":");
              if (!prop?.trim()) return "";
              return `${prop.trim().toLowerCase()}: ${valueParts.join(":").trim().replace(/\s+/g, " ")}`;
            })
            .filter(Boolean)
        });
      }
      return entries;
    };
    // -webkit- が先・標準が後の順を固定する: Tailwind v4 (Lightning CSS) は
    // 「標準→-webkit-」の並びだと標準宣言を落として emit し、標準のみ実装の
    // ブラウザで blur が消える (codex P2 — built CSS 実測で確認)。prefix-first
    // なら両方 emit される (プローブ実証)。
    const FACE_DECLS = (borderVar: string, shadowVar: string) => [
      "background: var(--mg-active-paper-elevated)",
      `border: 1px solid var(${borderVar})`,
      `box-shadow: var(${shadowVar})`,
      "-webkit-backdrop-filter: none",
      "backdrop-filter: none"
    ];
    const SUPPORTS_DECLS = (bgVar: string, blurVar: string) => [
      `background: var(${bgVar})`,
      `-webkit-backdrop-filter: blur(var(${blurVar})) saturate(1.8)`,
      `backdrop-filter: blur(var(${blurVar})) saturate(1.8)`
    ];
    const OPAQUE_FALLBACK_DECLS = [
      "background: var(--mg-active-paper-elevated)",
      "-webkit-backdrop-filter: none",
      "backdrop-filter: none"
    ];
    expect(materialRuleProps(sharedCss)).toEqual([
      { prelude: ".surface", props: FACE_DECLS("--mg-active-hairline", "--mg-active-glass-thin-shadow") },
      { prelude: ".glass-thick", props: FACE_DECLS("--mg-active-glass-thick-border", "--mg-active-glass-thick-shadow") },
      { prelude: ".glass-mid", props: FACE_DECLS("--mg-active-glass-mid-border", "--mg-active-glass-mid-shadow") },
      { prelude: ".glass-thin", props: FACE_DECLS("--mg-active-glass-thin-border", "--mg-active-glass-thin-shadow") },
      { prelude: ".glass-modal", props: FACE_DECLS("--mg-active-glass-thick-border", "--mg-active-glass-thick-shadow") },
      { prelude: ".glass-thick", props: SUPPORTS_DECLS("--mg-active-glass-thick-bg", "--mg-glass-thick-blur") },
      { prelude: ".glass-mid", props: SUPPORTS_DECLS("--mg-active-glass-mid-bg", "--mg-glass-mid-blur") },
      { prelude: ".glass-thin", props: SUPPORTS_DECLS("--mg-active-glass-thin-bg", "--mg-glass-thin-blur") },
      { prelude: ".glass-modal", props: SUPPORTS_DECLS("--mg-active-glass-modal-bg", "--mg-glass-thick-blur") },
      {
        prelude: ".surface, .glass-thick, .glass-mid, .glass-thin, .glass-modal",
        props: ["transition-duration: 0.01ms", "animation-duration: 0.01ms", "animation-iteration-count: 1"]
      },
      { prelude: ".glass-thick, .glass-mid, .glass-thin, .glass-modal", props: OPAQUE_FALLBACK_DECLS },
      {
        prelude: ".surface, .glass-thick, .glass-mid, .glass-thin, .glass-modal",
        props: [
          "background: var(--mg-active-paper-elevated)",
          "border: 1px solid var(--mg-active-ink)",
          "-webkit-backdrop-filter: none",
          "backdrop-filter: none"
        ]
      }
    ]);
    // Red fixtures: a case-variant duplicate, a conflicting longhand, and a
    // value drift all surface in the normalized declaration list.
    expect(
      materialRuleProps(".glass-thick { background: var(--a); BACKGROUND: var(--b); }")[0].props
    ).toEqual(["background: var(--a)", "background: var(--b)"]);
    expect(
      materialRuleProps(".glass-thick { background: var(--a); background-color: var(--b); }")[0].props
    ).toEqual(["background: var(--a)", "background-color: var(--b)"]);
    expect(
      materialRuleProps(".surface { transition-duration: 2s; }")[0].props
    ).toEqual(["transition-duration: 2s"]);
    // Consumers must not key any rule on a material class: geometry belongs on
    // the consumer's own class, faces on the material layer (glass-tokens.css).
    expect(materialRules(publicCss)).toEqual([]);
    // Red fixture: a consumer-side material override is caught.
    expect(materialRules(".surface { background: var(--mg-active-paper); }")).toHaveLength(1);
    expect(materialRules("@media (min-width: 320px) { .foo .glass-mid { filter: none; } }")).toHaveLength(1);

  });

  it("keeps face properties owned by the material layer on material-carrying consumers", () => {
    // A rule targeting a material-carrying element (compound, grouped, or
    // inside @media alike) must not re-declare the face properties the material
    // layer owns: styles.css loads after the @import, so a same-specificity
    // re-declaration would silently defeat the prefers-contrast /
    // reduced-transparency overrides in glass-tokens.css.
    expect(faceViolations(publicCss)).toEqual([]);
    // The one allowlisted face exception is value- and count-pinned: the step
    // bar shows only its bottom hairline. A second border-width (e.g. a later
    // `.step-progress { border-width: 0 }` killing the contrast border) fails.
    const stepBorderWidths: string[] = [];
    for (const rule of stripCssComments(publicCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const compound of rule[1].trim().split(",")) {
        if (!/\.step-progress(?![\w-])/.test(compound.trim().split(/\s+/).pop() ?? "")) continue;
        for (const declaration of rule[2].split(";")) {
          const [prop, ...valueParts] = declaration.split(":");
          if ((prop ?? "").trim().toLowerCase() === "border-width") {
            stepBorderWidths.push(valueParts.join(":").trim());
          }
        }
      }
    }
    expect(stepBorderWidths).toEqual(["0 0 1px"]);
  });

  it("face-property guard self-test: compound, grouped, and media overrides are caught", () => {
    expect(faceViolations(".services-popover { background: var(--x); }")).toHaveLength(1);
    expect(faceViolations(".services-popover.surface { background: var(--x); }")).toHaveLength(1);
    expect(faceViolations(".other, .services-popover { border: 1px solid var(--x); }")).toHaveLength(1);
    expect(faceViolations("@media (min-width: 320px) { .step-progress { background: var(--x); } }")).toHaveLength(1);
    // Logical properties and every border/background longhand are the same
    // face via another name; property names are case-insensitive.
    expect(faceViolations(".step-progress { border-inline-color: var(--x); }")).toHaveLength(1);
    expect(faceViolations(".step-progress { border-block-start: 1px solid var(--x); }")).toHaveLength(1);
    expect(faceViolations(".step-progress { background-image: none; }")).toHaveLength(1);
    expect(faceViolations(".step-progress { border-inline-style: none; }")).toHaveLength(1);
    expect(faceViolations(".step-progress { border-block-start-width: 0; }")).toHaveLength(1);
    expect(faceViolations(".step-progress { border-image-source: none; }")).toHaveLength(1);
    expect(faceViolations(".services-popover { BACKGROUND: var(--x); }")).toHaveLength(1);
    // Descendants, allowlisted state colors, and the phone-card shadow pass.
    expect(faceViolations(".services-popover .service-list { background: var(--x); }")).toHaveLength(0);
    expect(
      faceViolations('.customer-reservations-page #status-banner[data-tone="error"] { border-color: var(--x); }')
    ).toHaveLength(0);
    expect(faceViolations(".reservation-panel { box-shadow: var(--x); }")).toHaveLength(0);
  });

  it("keeps every consumer free of raw colors and raw effects", () => {
    expect(cssValueViolations(publicCss), "styles.css").toEqual([]);
    expect(htmlViolations(publicHtml), "index.html").toEqual([]);
    for (const { name, html } of legalPages) {
      expect(htmlViolations(html), `legal/${name}.html`).toEqual([]);
    }
    expect(jsViolations(publicApp), "app.js").toEqual([]);
    expect(jsViolations(customerJs), "customer/reservations.js").toEqual([]);
    expect(jsViolations(customerSsr), "customer/reservations-page.ts").toEqual([]);
    expect(htmlViolations(customerSsr), "customer/reservations-page.ts markup").toEqual([]);
  });

  it("pins the transform movers and their reduced-motion kill switches (FR-008)", () => {
    // Movement transitions do not inherit, so the shared material block cannot
    // cover consumer-side movement. The mover LIST is pinned with positions:
    // adding any new transform transition — including re-declaring the caret's
    // AFTER the kill switch, where it would win the cascade — fails here.
    // Case-insensitive: CSS accepts `TRANSITION: TRANSFORM` / `TRANSITION: ALL`.
    const transformMoverEntries = (css: string) => {
      const entries: Array<{ key: string; index: number }> = [];
      for (const rule of blankCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/transition(?:-property)?\s*:[^;]*transform/i.test(rule[2])) continue;
        for (const compound of rule[1].trim().split(",")) {
          entries.push({ key: compound.trim().split(/\s+/).pop() ?? "", index: rule.index ?? 0 });
        }
      }
      return entries;
    };
    // `transition: all` silently includes transform — banned outright.
    const TRANSITION_ALL = /transition(?:-property)?\s*:[^;{}]*\ball\b/i;
    expect(stripCssComments(publicCss)).not.toMatch(TRANSITION_ALL);
    const movers = transformMoverEntries(publicCss);
    expect(movers.map((mover) => mover.key)).toEqual([".services-trigger-caret"]);
    const killSwitch = blankCssComments(publicCss).match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.services-trigger-caret\s*\{\s*transition:\s*none;?\s*\}\s*\}/
    );
    expect(killSwitch?.index).toBeDefined();
    for (const mover of movers) {
      expect(
        mover.index < (killSwitch?.index ?? -1),
        "every caret transition must precede its reduced-motion kill switch"
      ).toBe(true);
    }
    // Detector self-tests: class, id, and longhand movers are all seen, and a
    // mover re-declared AFTER the kill switch is caught by the position check.
    expect(transformMoverEntries(".foo { transition: transform 1s; }").map((m) => m.key)).toEqual([".foo"]);
    expect(transformMoverEntries("#bar { transition-property: transform; }").map((m) => m.key)).toEqual(["#bar"]);
    expect(transformMoverEntries(".baz { TRANSITION: TRANSFORM 1s; }").map((m) => m.key)).toEqual([".baz"]);
    expect(TRANSITION_ALL.test(".qux { TRANSITION: ALL var(--mg-motion-fast); }")).toBe(true);
    const lateOverride =
      "@media (prefers-reduced-motion: reduce) { .services-trigger-caret { transition: none; } }\n" +
      ".services-trigger-caret { transition: transform 1s; }";
    const lateMovers = transformMoverEntries(lateOverride);
    const lateKill = lateOverride.indexOf("@media");
    expect(lateMovers.some((mover) => mover.index > lateKill)).toBe(true);
  });

  it("pins the 2px keyboard focus ring on form fields (visible focus, WCAG)", () => {
    // The legacy `:focus { outline: none }` reset survives for mouse focus,
    // so the 2px :focus-visible ring MUST exist and MUST be declared after it
    // (same specificity — source order decides the cascade).
    const css = stripCssComments(publicCss);
    const reset = css.match(/select:focus,\s*input:focus\s*\{[^{}]*outline:\s*none[^{}]*\}/i);
    const ring = css.match(
      /select:focus-visible,\s*input:focus-visible\s*\{\s*outline:\s*2px solid var\(--color-border-focus\);\s*outline-offset:\s*2px;?\s*\}/i
    );
    expect(reset?.index).toBeDefined();
    expect(ring?.index).toBeDefined();
    expect((ring?.index ?? -1) > (reset?.index ?? Infinity)).toBe(true);
  });

  it("pins the light and dark theme-color metas on every static page", () => {
    // Exact media match: a substring test would accept a contradictory
    // `(prefers-color-scheme: light) and (prefers-color-scheme: dark)` that
    // never applies.
    for (const { name, html } of [{ name: "index.html", html: publicHtml }, ...legalPages]) {
      const metas = themeColorMetas(html);
      expect(
        metas.filter((m) => m.content === "#FAFAFA" && m.media.trim() === "(prefers-color-scheme: light)")
          .length,
        `${name}: light theme-color meta`
      ).toBe(1);
      expect(
        metas.filter((m) => m.content === "#111111" && m.media.trim() === "(prefers-color-scheme: dark)")
          .length,
        `${name}: dark theme-color meta`
      ).toBe(1);
      expect(metas.length, `${name}: unexpected extra theme-color metas`).toBe(2);
    }
    // Red fixture: the contradictory media form counts for neither side.
    const contradictory = themeColorMetas(
      '<meta name="theme-color" content="#FAFAFA" media="(prefers-color-scheme: light) and (prefers-color-scheme: dark)" />'
    );
    expect(
      contradictory.filter((m) => m.media.trim() === "(prefers-color-scheme: light)")
    ).toHaveLength(0);
  });

  it("keeps public motion and radii on the shared scales", () => {
    const stripped = stripCssComments(publicCss);
    for (const declaration of stripped.match(/(?:transition|animation)(?:-(?:delay|duration))?:[^;]+;/g) ?? []) {
      expect(declaration, `raw motion value: ${declaration}`).not.toMatch(/\b\d+(?:\.\d+)?m?s\b/);
    }
    for (const declaration of stripped.match(
      /(?:border-radius|border-(?:top-left|top-right|bottom-left|bottom-right|start-start|start-end|end-start|end-end)-radius):[^;]+;/g
    ) ?? []) {
      expect(declaration, `raw radius value: ${declaration}`).not.toMatch(
        /(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|ch|vw|vh|vmin|vmax)\b/
      );
    }
  });

  it("only remaps active aliases in consumers, never raw shared tokens", () => {
    for (const source of [publicCss, customerSsr]) {
      for (const match of source.matchAll(/(?:^|[{;])\s*(--mg-[a-z0-9-]+)\s*:/gm)) {
        expect(match[1], `consumer re-declares a raw shared token: ${match[1]}`).toMatch(/^--mg-active-/);
      }
    }
  });
});

/* ── Admin consumer mapping (contract items 12-13, PR-G2) ── */

// React inline-style objects are an admin-only raw-value channel (contract
// item 9: `style={{ color: "#..." }}`); the DOM-mutation detector cannot see
// them because JSX never goes through .style assignments.
// CSS <system-color> keywords (current + deprecated), exact-match and
// case-INSENSITIVE like CSS itself ("canvastext" and "cAnVaStExT" are valid
// color values). Collisions with innocent strings ("menu" route id, "window")
// are handled by the per-file NAMED_LITERAL_ALLOWLIST at the call site — the
// grammar itself stays complete.
const EXACT_SYSTEM_COLOR =
  /^(?:accentcolor|accentcolortext|activetext|buttonborder|buttonface|buttontext|canvas|canvastext|field|fieldtext|graytext|highlight|highlighttext|linktext|mark|marktext|selecteditem|selecteditemtext|visitedtext|activeborder|activecaption|appworkspace|background|buttonhighlight|buttonshadow|captiontext|inactiveborder|inactivecaption|inactivecaptiontext|infobackground|infotext|menu|menutext|scrollbar|threeddarkshadow|threedface|threedhighlight|threedlightshadow|threedshadow|window|windowframe|windowtext)$/i;

// Full CSS Color 4 <named-color> set, exact-match form (system colors
// deliberately absent — see the usage comment below).
const EXACT_NAMED_COLOR =
  /^(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)$/i;

const styleObjectViolations = (source: string) => {
  const stripped = stripJsComments(source);
  const violations: string[] = [];
  const inlineSpans: Array<[number, number]> = [];
  for (const match of stripped.matchAll(/style=\{\{([^{}]*)\}\}/g)) {
    inlineSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
    if (rawColorIn(match[1])) violations.push(`style object: ${match[1].trim()}`);
  }
  // `style={inlineStyle}` escapes the JSX-inline form above — scan color-bearing
  // properties in EVERY object literal (quoted values only, so TS type
  // annotations like `color: string` stay out of scope). Matches inside a
  // style={{…}} span are already reported by the first loop.
  const propSpans: Array<[number, number]> = [];
  for (const match of stripped.matchAll(
    /\b(background|backgroundColor|backgroundImage|color|borderColor|outlineColor|textDecorationColor|caretColor|accentColor|fill|stroke|boxShadow)\s*:\s*(["'`])((?:(?!\2)[\s\S])*)\2/g
  )) {
    const at = match.index ?? 0;
    if (inlineSpans.some(([from, to]) => at >= from && at < to)) continue;
    propSpans.push([at, at + match[0].length]);
    if (rawColorIn(match[3])) violations.push(`object color prop: ${match[1]}: ${match[3].trim()}`);
  }
  // Indirection-proof backstop (codex PR-G2: `const raw = "#123"; {color: raw}`
  // and conditional/computed/shorthand forms evade property-adjacent matching):
  // ANY string literal containing a hex / color-function / gradient value is a
  // violation, wherever it flows afterwards. Named colors are deliberately NOT
  // matched here — CSS <system-color> words (menu, mark, field…) collide with
  // ordinary strings like import paths; they stay enforced on color-property
  // adjacency above. Imported cross-file constants remain out of reach of a
  // single-file scan; the shared token file is the only sanctioned source of
  // raw values either way.
  for (const match of stripped.matchAll(/(["'`])((?:(?!\1)[\s\S])*)\1/g)) {
    const at = match.index ?? 0;
    if (inlineSpans.some(([from, to]) => at >= from && at < to)) continue;
    if (propSpans.some(([from, to]) => at >= from && at < to)) continue;
    if (COLOR_FUNCTION.test(match[2]) || RAW_EFFECT.test(match[2])) {
      violations.push(`string literal color: ${match[2].trim().slice(0, 60)}`);
    } else if (EXACT_NAMED_COLOR.test(match[2].trim()) || EXACT_SYSTEM_COLOR.test(match[2].trim())) {
      // A literal that IS a named color (`const raw = "red"`) or a CamelCase
      // system color (`"CanvasText"`) — the substring form stays
      // property-adjacent only, but the exact form has no innocent reading
      // (lowercase system-color words like menu/field are excluded — they
      // collide with route ids and DOM globals).
      violations.push(`named color literal: ${match[2].trim()}`);
    }
  }
  // Duplicates are MEANINGFUL: the per-file allowlist consumes exactly one
  // occurrence per entry, so a second `"menu"` (e.g. flowing into a style)
  // must survive as a residual violation. Overlap between the three loops is
  // prevented positionally (inlineSpans / propSpans), not by deduping.
  return violations;
};

// Contract item 13: chromatic Tailwind utilities (variant prefixes included —
// the match anchors on the utility tail) and arbitrary-value color utilities.
// Every Tailwind 4 color channel, directional/offset/inset derivatives
// included (codex PR-G2: border-t-red-500 / ring-offset-red-500 /
// placeholder-red-500 generate CSS but escaped the base-prefix grammar).
const CHROMATIC_PREFIX =
  "(?:bg|text|border(?:-(?:[trblxyse]|bs|be))?|ring(?:-offset)?|inset-ring|fill|stroke|from|via|to|outline|decoration|divide|accent|caret|shadow|inset-shadow|drop-shadow|text-shadow|filter|backdrop-filter|placeholder|scrollbar-(?:thumb|track))";
// Color families are DERIVED from the installed Tailwind's theme.css — a
// hand-kept list rots silently on upgrade (4.3 shipped mauve/mist/olive/taupe
// past a 22-name list unseen; codex fresh-review finding). Fail-closed: a
// missing file or an implausibly small derivation throws at import time.
const TAILWIND_THEME_PATH = "admin-app/node_modules/tailwindcss/theme.css";
if (!existsSync(TAILWIND_THEME_PATH)) {
  // 素の ENOENT だと fresh checkout で原因が読めない (root install だけでは
  // admin の依存木が無い)。root 依存に tailwind を重複追加すると admin の実
  // バージョンとドリフトするので、導出元は admin の依存木のまま固定する。
  throw new Error(
    `${TAILWIND_THEME_PATH} not found — run \`npm ci --ignore-scripts --prefix admin-app\` first (README Local Setup)`,
  );
}
const tailwindThemeCss = readFileSync(TAILWIND_THEME_PATH, "utf8");
const TAILWIND_COLOR_FAMILIES = [
  ...new Set([...tailwindThemeCss.matchAll(/--color-([a-z]+)-\d+\s*:/g)].map((match) => match[1]))
].sort();
if (TAILWIND_COLOR_FAMILIES.length < 25) {
  throw new Error(`tailwind palette derivation broke: ${TAILWIND_COLOR_FAMILIES.length} families`);
}
// black/white carry no numeric scale but are direct colors all the same —
// bg-black/80 (the pre-token scrim) passed a scale-only grammar unseen (codex
// fresh-review finding). The lookahead keeps "blacklist"/"white-space"-style
// identifiers out.
const COLORED_UTILITY = new RegExp(
  `${CHROMATIC_PREFIX}-(?:(?:${TAILWIND_COLOR_FAMILIES.join("|")})-\\d+(?:\\/\\d+)?|(?:black|white)(?:\\/\\d+)?(?![\\w-]))`,
  "g"
);
// Three arbitrary-value escape hatches, all banned (codex PR-G2 finding —
// `bg-[red]`, `bg-[var(--mg-paper)]`, `[color:red]` bypassed the value-form
// regex): (1) color-typed arbitrary VALUES on any utility root, (2) ANY
// arbitrary value on a chromatic-capable utility root (the channel is the
// violation, whatever the value form), (3) arbitrary-property classes that
// set color properties directly.
const ARBITRARY_COLOR_UTILITY =
  /[a-z][a-z-]*-\[(?:#[0-9a-fA-F]|(?:rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch|color-mix|color|light-dark)\()[^\]]*\]/g;
// Both Tailwind arbitrary-value spellings: square brackets (`bg-[red]`) AND
// the v4 CSS-variable shorthand (`bg-(--probe)`) — the paren form generates
// CSS just the same (codex PR-G2 bypass).
const ARBITRARY_CHROMATIC_PREFIX = new RegExp(
  `(?:^|[\\s"'\`{:(])(${CHROMATIC_PREFIX}(?:-\\[[^\\]]*\\]|-\\([^)]*\\)))`,
  "g"
);
// Arbitrary-PROPERTY classes (`[prop:value]`): instead of enumerating color
// properties (an arms race — -webkit-text-fill-color, text-emphasis-color,
// scrollbar-color… all generate CSS), extract EVERY property/value pair and
// flag it when the property is color-bearing (`*color*`, background, or the
// shadow/filter family — var() routes included) OR the value itself is a raw
// color (underscores are Tailwind's spaces). `supports-[backdrop-filter]:` and
// `data-[state=open]:` variants have no `prop:value` shape and never match.
// Property names may be vendor-prefixed, UPPERCASE (CSS identifiers are
// case-insensitive — Tailwind generates `[-WEBKIT-TEXT-FILL-COLOR:red]`
// verbatim), or custom properties (`[--raw:red]`); shorthands that accept a
// color (border, outline, text-decoration, column-rule) are fail-closed even
// with var() values.
const ARBITRARY_ANY_PROPERTY = /(?:^|[\s"'`{:(])(\[((?:--|-)?[a-zA-Z][a-zA-Z0-9-]*)\s*:([^\]]+)\])/g;
const COLOR_BEARING_PROPERTY =
  /color|^(?:background[a-z-]*|border[a-z-]*|outline[a-z-]*|text-decoration[a-z-]*|column-rule[a-z-]*|fill|stroke|box-shadow|text-shadow|filter|backdrop-filter)$/;
const isArbitraryColorProperty = (prop: string, value: string) => {
  const isCustom = prop.startsWith("--");
  // Custom properties are judged by VALUE only (a name proves nothing);
  // real properties are lowercased before the name test. Independently of the
  // property NAME, any direct var(--mg-…) reference is a raw-token route out
  // of the utility/material system (text-emphasis, -webkit-text-stroke… —
  // enumerating color-accepting shorthands is an arms race, the token
  // reference itself is the violation).
  return (!isCustom && COLOR_BEARING_PROPERTY.test(prop.toLowerCase())) ||
    /var\(\s*--mg-/.test(value) ||
    rawColorIn(value.replace(/_/g, " "));
};
const arbitraryColorViolations = (stripped: string) => [
  ...new Set([
    ...[...stripped.matchAll(ARBITRARY_COLOR_UTILITY)].map((match) => match[0]),
    ...[...stripped.matchAll(ARBITRARY_CHROMATIC_PREFIX)].map((match) => match[1]),
    ...[...stripped.matchAll(ARBITRARY_ANY_PROPERTY)]
      .filter((match) => isArbitraryColorProperty(match[2], match[3]))
      .map((match) => match[1])
  ])
];

// Business-semantic allowlist (FR-009): reservation-status colors and their
// legend/derivatives, approval-pending amber, LINE quota/link status, warning
// notes, the timeline now-line, and calendar "today" highlights. Everything
// chromatic outside this map is a chrome violation. Pinned two-way AND by
// OCCURRENCE COUNT (codex PR-G2 finding: a name-only set let an allowlisted
// utility be re-added to non-semantic chrome in the same file undetected).
const ADMIN_COLORED_UTILITY_ALLOWLIST: Record<string, Record<string, number>> = {
  // Customer chart: LINE linkage and treatment caution, never navigation chrome.
  "admin-app/src/components/customers/customer-detail-panel.tsx": {
    "border-emerald-200": 1, "bg-emerald-50": 1, "text-emerald-700": 1,
    "border-amber-200": 1, "bg-amber-50": 1, "text-amber-950": 1
  },
  // A conflicting chart write is a semantic warning; exact occurrence counts stay pinned.
  "admin-app/src/components/customers/chart-conflict-notice.tsx": {
    "border-amber-300": 1, "bg-amber-50": 1, "text-amber-950": 1
  },
  // Reservation status palette (FR-009 explicitly keeps it).
  "admin-app/src/lib/timeline.ts": {
    "bg-amber-100": 1, "bg-amber-950": 1, "bg-blue-100": 1, "bg-blue-950": 1, "bg-gray-100": 3,
    "bg-gray-900": 3, "bg-green-100": 1, "bg-green-950": 1, "bg-indigo-100": 1, "bg-indigo-950": 1,
    "bg-orange-100": 1, "bg-orange-950": 1, "bg-red-100": 1, "bg-red-950": 1, "border-amber-400": 1,
    "border-amber-600": 1, "border-blue-400": 1, "border-blue-600": 1, "border-gray-300": 3,
    "border-gray-600": 3, "border-green-400": 1, "border-green-600": 1, "border-indigo-400": 1,
    "border-indigo-600": 1, "border-orange-400": 1, "border-orange-600": 1, "border-red-400": 1,
    "border-red-600": 1, "text-amber-100": 1, "text-amber-900": 1, "text-blue-100": 1,
    "text-blue-900": 1, "text-gray-300": 1, "text-gray-400": 2,
    "text-gray-600": 3, "text-green-100": 1, "text-green-900": 1, "text-indigo-100": 1,
    "text-indigo-900": 1, "text-orange-100": 1, "text-orange-900": 1, "text-red-100": 1,
    "text-red-900": 1
  },
  // Assertions mirroring the STATUS_COLORS contract.
  "admin-app/src/lib/timeline.test.ts": { "bg-blue-100": 1, "bg-orange-100": 1 },
  // Status legend chips (same semantic hues as STATUS_COLORS).
  "admin-app/src/components/schedule/schedule-header.tsx": {
    "bg-amber-50": 1, "bg-amber-950": 1, "bg-blue-50": 1, "bg-blue-950": 1, "bg-green-50": 1,
    "bg-green-950": 1, "border-amber-400": 1, "border-blue-400": 1, "border-green-400": 1,
    "text-amber-200": 1, "text-amber-700": 1, "text-blue-200": 1, "text-blue-700": 1,
    "text-green-200": 1, "text-green-700": 1
  },
  // Approval-pending amber (matches the pending_approval status hue).
  "admin-app/src/components/schedule/pending-approvals-card.tsx": {
    "bg-amber-200": 1, "bg-amber-50/40": 1, "bg-amber-800": 1, "bg-amber-950/20": 1,
    "text-amber-100": 1, "text-amber-50": 1, "text-amber-900": 2
  },
  "admin-app/src/components/sidebar.tsx": { "bg-amber-500": 2, "text-amber-950": 1 },
  // External (Google) blocks render gray like the cancelled status pair.
  "admin-app/src/components/schedule/external-block-card.tsx": {
    "border-gray-300": 1, "border-gray-400": 2, "border-gray-600": 1, "text-gray-200": 2,
    "text-gray-400": 1, "text-gray-600": 1, "text-gray-700": 2
  },
  // Timeline now-line (calendar convention).
  "admin-app/src/components/schedule/timeline-grid.tsx": { "bg-red-500": 1, "border-red-500": 1 },
  // Calendar "today" highlight.
  "admin-app/src/components/schedule/mini-calendar.tsx": { "text-blue-400": 1, "text-blue-600": 1 },
  "admin-app/src/pages/schedule.tsx": {
    "bg-blue-50": 1, "bg-blue-50/40": 1, "bg-blue-950": 1, "bg-blue-950/30": 1,
    "text-blue-400": 1, "text-blue-600": 1
  },
  // LINE quota gauge severity levels and LINE link status.
  "admin-app/src/components/settings/line-quota-card.tsx": {
    "bg-amber-500": 1, "bg-green-500": 1, "bg-red-500": 1, "text-amber-600": 1, "text-red-600": 1
  },
  "admin-app/src/pages/line-friends.tsx": { "text-emerald-400": 1, "text-emerald-700": 1 },
  // Warning notes and badges (amber/orange semantic caution).
  "admin-app/src/pages/activity.tsx": { "text-amber-400": 1, "text-amber-600": 1 },
  "admin-app/src/pages/cancellation-fees.tsx": {
    "bg-amber-50": 1, "border-amber-500/50": 1, "text-amber-900": 1
  },
  "admin-app/src/pages/notifications.tsx": { "text-amber-600": 1 },
  "admin-app/src/pages/reservations.tsx": { "text-amber-400": 1, "text-amber-600": 1 },
  "admin-app/src/pages/store-logins.tsx": {
    "bg-orange-100": 2, "border-orange-300": 1, "text-orange-800": 1
  },
  "admin-app/src/components/menu/service-detail-panel.tsx": { "text-amber-400": 1, "text-amber-600": 1 },
  "admin-app/src/components/settings/recurring-blocks-tab.tsx": { "text-amber-600": 1 }
};

describe("Monotone Liquid Glass admin token mapping", () => {
  it("imports the shared source before all admin rules", () => {
    expect(adminCss.trimStart()).toMatch(/^@import "\.\.\/\.\.\/public\/glass-tokens\.css";/);
  });

  it("declares the class-driven dark variant and color-scheme pair in order (item 12(e))", () => {
    // Exactly one @custom-variant dark, exact form — anything else lets dark:*
    // utilities fall back to prefers-color-scheme and fight use-theme.ts.
    const variantForm = "@custom-variant dark (&:where(.dark, .dark *));";
    const stripped = stripCssComments(adminCss);
    expect(stripped.split(variantForm).length - 1).toBe(1);
    expect(stripped).not.toContain("prefers-color-scheme");
    // Statement order is load-bearing: imports must precede the variant, the
    // theme mapping, and both color-scheme roots.
    const blanked = blankCssComments(adminCss);
    const importIndex = blanked.indexOf('@import "../../public/glass-tokens.css";');
    const variantIndex = blanked.indexOf(variantForm);
    const themeIndex = blanked.indexOf("@theme inline");
    const rootIndex = blanked.search(/(?:^|\n):root\s*\{/);
    const darkIndex = blanked.search(/(?:^|\n)\.dark\s*\{/);
    expect(importIndex).toBeGreaterThan(-1);
    expect(variantIndex).toBeGreaterThan(importIndex);
    expect(themeIndex).toBeGreaterThan(variantIndex);
    expect(rootIndex).toBeGreaterThan(themeIndex);
    expect(darkIndex).toBeGreaterThan(rootIndex);
    // Native UI (date/time inputs) must follow the manual theme (research R3).
    expect(ruleBody(blanked.slice(rootIndex, darkIndex), ":root")).toMatch(/color-scheme:\s*light/);
    expect(ruleBody(adminCss, ".dark")).toMatch(/color-scheme:\s*dark/);
  });

  it("maps every Tailwind semantic variable to active shared tokens (item 12(a)-(c))", () => {
    const expectedTheme = new Map<string, string>([
      ["--color-background", "var(--mg-active-paper)"],
      ["--color-foreground", "var(--mg-active-ink)"],
      ["--color-card", "var(--mg-active-paper-elevated)"],
      ["--color-card-foreground", "var(--mg-active-ink)"],
      ["--color-popover", "var(--mg-active-paper-elevated)"],
      ["--color-popover-foreground", "var(--mg-active-ink)"],
      ["--color-primary", "var(--mg-active-ink)"],
      ["--color-primary-foreground", "var(--mg-active-on-ink)"],
      ["--color-secondary", "var(--mg-active-fill-subtle)"],
      ["--color-secondary-foreground", "var(--mg-active-ink)"],
      ["--color-muted", "var(--mg-active-fill-subtle)"],
      ["--color-muted-foreground", "var(--mg-active-ink-secondary)"],
      ["--color-accent", "var(--mg-active-fill-subtle)"],
      ["--color-accent-foreground", "var(--mg-active-ink)"],
      ["--color-destructive", "var(--mg-active-error)"],
      ["--color-destructive-foreground", "var(--mg-active-on-ink)"],
      ["--color-border", "var(--mg-active-hairline)"],
      ["--color-input", "var(--mg-active-hairline)"],
      ["--color-ring", "var(--mg-active-ink)"],
      ["--color-sidebar-background", "var(--mg-active-paper)"],
      ["--color-sidebar-foreground", "var(--mg-active-ink-secondary)"],
      ["--color-sidebar-primary", "var(--mg-active-ink)"],
      ["--color-sidebar-primary-foreground", "var(--mg-active-on-ink)"],
      ["--color-sidebar-accent", "var(--mg-active-ink)"],
      ["--color-sidebar-accent-foreground", "var(--mg-active-on-ink)"],
      ["--color-sidebar-border", "var(--mg-active-hairline)"],
      ["--color-sidebar-ring", "var(--mg-active-ink-disabled)"],
      // Radix overlay scrim (dialog/sheet/alert-dialog) — tokenized so the
      // raw bg-black/80 literal never returns (codex fresh-review finding).
      ["--color-scrim", "var(--mg-active-scrim)"],
      // Fixed radius correspondence (item 12(b)): lg=card / md=btn / sm=field.
      ["--radius-lg", "var(--mg-radius-card)"],
      ["--radius-md", "var(--mg-radius-btn)"],
      ["--radius-sm", "var(--mg-radius-field)"],
      // Fonts sit outside the shared token model (item 12(c)): pin current values.
      ["--font-sans", "ui-sans-serif, system-ui, sans-serif"],
      ["--font-mono", "ui-monospace, SFMono-Regular, monospace"]
    ]);
    const blanked = blankCssComments(adminCss);
    const themeBlock = blanked.match(/@theme inline\s*\{[^{}]*\}/);
    expect(themeBlock?.index).toBeDefined();
    const themeStart = themeBlock?.index ?? 0;
    const themeEnd = themeStart + (themeBlock?.[0].length ?? 0);
    const declarations = [
      ...blanked.matchAll(/(?:^|[{;])\s*(--(?:color|radius|font)-[a-z0-9-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/gm)
    ];
    for (const [name, value] of expectedTheme) {
      const own = declarations.filter((match) => match[1] === name);
      expect(own.length, `${name} declared ${own.length} times`).toBe(1);
      expect(own[0][2].trim(), `${name} value drifted`).toBe(value);
      const at = own[0].index ?? 0;
      expect(at >= themeStart && at < themeEnd, `${name} declared outside @theme inline`).toBe(true);
    }
    const unexpected = declarations.map((match) => match[1]).filter((name) => !expectedTheme.has(name));
    expect(unexpected, `theme variables outside the contract: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("remaps every dark-paired active alias in the .dark block, and only those (item 12(d))", () => {
    // Derived from the shared source exactly like the public OS-dark check, so
    // a token added to glass-tokens.css cannot be silently missed here.
    const darkNames = [...stripCssComments(sharedCss).matchAll(/--mg-dark-([a-z0-9-]+)\s*:/g)].map(
      (match) => match[1]
    );
    expect(darkNames.length).toBeGreaterThan(0);
    const expectedDarkMap = new Map(
      darkNames.map((name) => [`--mg-active-${name}`, `var(--mg-dark-${name})`] as const)
    );
    const darkBody = ruleBody(blankCssComments(adminCss), ".dark");
    expect(darkBody).not.toBe("");
    const actualDarkMap = new Map<string, string>();
    for (const match of darkBody.matchAll(/(--mg-active-[a-z0-9-]+)\s*:\s*([^;{}]+?)\s*(?=[;\n]|$)/g)) {
      actualDarkMap.set(match[1], match[2].trim());
    }
    expect(Object.fromEntries(actualDarkMap)).toEqual(Object.fromEntries(expectedDarkMap));
    for (const excluded of ["--mg-active-line:", "--mg-active-line-text:", "--mg-active-verified:"]) {
      expect(darkBody, `${excluded} must not be remapped (AA-safe inheritance)`).not.toContain(excluded);
    }
    // Anti-override: active aliases may be declared ONLY inside .dark, each
    // exactly once — a later :root remap would silently undo the dark theme.
    const blanked = blankCssComments(adminCss);
    const darkRule = blanked.match(/(?:^|\n)\.dark\s*\{[^{}]*\}/);
    expect(darkRule?.index).toBeDefined();
    const darkStart = darkRule?.index ?? 0;
    const darkEnd = darkStart + (darkRule?.[0].length ?? 0);
    const activeCounts = new Map<string, number>();
    for (const match of blanked.matchAll(/(?:^|[{;])\s*(--mg-active-[a-z0-9-]+)\s*:/gm)) {
      const at = match.index ?? 0;
      expect(
        at >= darkStart && at < darkEnd,
        `${match[1]} declared outside the .dark block in index.css`
      ).toBe(true);
      activeCounts.set(match[1], (activeCounts.get(match[1]) ?? 0) + 1);
    }
    for (const [name, count] of activeCounts) {
      expect(count, `${name} declared ${count} times in index.css`).toBe(1);
    }
    // Raw shared tokens are never re-declared by the admin consumer, and
    // material classes stay confined to the shared source (item 3).
    for (const match of adminCss.matchAll(/(?:^|[{;])\s*(--mg-[a-z0-9-]+)\s*:/gm)) {
      expect(match[1], `admin re-declares a raw shared token: ${match[1]}`).toMatch(/^--mg-active-/);
    }
    expect(stripCssComments(adminCss)).not.toMatch(/\.(?:surface|glass-thick|glass-mid|glass-thin|glass-modal)(?![\w-])/);
  });

  it("keeps admin sources free of raw colors in CSS, DOM mutations, and style objects (item 9)", () => {
    // Exact-literal collisions with the case-insensitive system-color grammar
    // — innocent strings pinned per file and per formatted violation. A new
    // occurrence anywhere else still fails.
    const NAMED_LITERAL_ALLOWLIST: Record<string, string[]> = {
      "admin-app/src/routes.tsx": ["named color literal: menu"],
      "admin-app/src/lib/auth-logout.test.ts": ["named color literal: window"]
    };
    expect(cssValueViolations(adminCss), "index.css").toEqual([]);
    for (const { path, source } of adminSourceFiles) {
      if (path.endsWith(".css")) {
        expect(cssValueViolations(source), path).toEqual([]);
      } else {
        expect(jsViolations(source), path).toEqual([]);
        // Each allowlist entry consumes exactly ONE occurrence — a duplicate
        // of an allowed word still fails, and a stale entry fails too.
        const allowed = [...(NAMED_LITERAL_ALLOWLIST[path] ?? [])];
        const residual: string[] = [];
        for (const violation of styleObjectViolations(source)) {
          const hit = allowed.indexOf(violation);
          if (hit >= 0) allowed.splice(hit, 1);
          else residual.push(violation);
        }
        expect(residual, path).toEqual([]);
        expect(allowed, `${path}: stale allowlist entries`).toEqual([]);
      }
    }
    // Detector self-test: React inline-style objects are seen, percentages pass.
    expect(styleObjectViolations('<div style={{ color: "#123456" }} />')).toHaveLength(1);
    expect(styleObjectViolations('<div style={{ background: "oklch(0.5 0.1 200)" }} />')).toHaveLength(1);
    expect(styleObjectViolations('<div style={{ width: "50%", height: gaugeHeight }} />')).toEqual([]);
    // `style={inlineStyle}` indirection (codex PR-G2 bypass fixture): the
    // object literal itself is scanned, wherever it is declared…
    expect(styleObjectViolations(
      'const inlineStyle = { top: style.top, background: "repeating-linear-gradient(135deg, transparent, rgba(156,163,175,0.2) 8px)" };'
    )).toHaveLength(1);
    expect(styleObjectViolations('const s = { borderColor: "red" };')).toHaveLength(1);
    // …variable indirection, conditional, computed-property, and shorthand
    // forms are caught at the string literal itself…
    expect(styleObjectViolations('const raw = "#123456"; const s = { color: raw };')).toHaveLength(1);
    expect(styleObjectViolations('const c = cond ? "rgb(1, 2, 3)" : "oklch(0.5 0.1 200)";')).toHaveLength(2);
    expect(styleObjectViolations('const s = { ["color"]: "#ff0000" };')).toHaveLength(1);
    expect(styleObjectViolations('const color = "#ff0000"; const s = { color };')).toHaveLength(1);
    // Named colors flow the same way — the EXACT-literal form is unambiguous
    // (`"red"` has no innocent reading), system-color words stay allowed.
    expect(styleObjectViolations('const raw = "red"; const s = { color: raw };')).toHaveLength(1);
    expect(styleObjectViolations('const c = cond ? "red" : "teal";')).toHaveLength(2);
    expect(styleObjectViolations('const raw = "CanvasText"; const s = { color: raw };')).toHaveLength(1);
    expect(styleObjectViolations('const c = cond ? "FieldText" : "ButtonText";')).toHaveLength(2);
    // System colors are ASCII case-insensitive in CSS — every spelling and the
    // deprecated set are caught; innocent collisions ("menu" route id) are
    // handled by the per-file allowlist in the item 9 test, not the grammar.
    expect(styleObjectViolations('const a = "canvastext"; const b = "cAnVaStExT";')).toHaveLength(2);
    expect(styleObjectViolations('const legacy = cond ? "WindowText" : "menutext";')).toHaveLength(2);
    expect(styleObjectViolations('const el = document.body; el.style.color = "windowtext";')).toHaveLength(1);
    // Duplicates are preserved — a second occurrence of an allowlisted word
    // (one legit route id + one flowing into a style) yields TWO violations,
    // so the consume-one allowlist leaves a residual failure.
    expect(styleObjectViolations('const route = "menu"; const raw = "menu";')).toHaveLength(2);
    // …while geometry-only objects, TS type annotations, and Tailwind class
    // strings stay out of scope.
    expect(styleObjectViolations('const s = { top: y, height: h, minHeight: "20px", zIndex: 5 };')).toEqual([]);
    expect(styleObjectViolations("type P = { color: string };")).toEqual([]);
    expect(styleObjectViolations('cn("border-gray-300 text-gray-600 dark:text-gray-400")')).toEqual([]);
    expect(styleObjectViolations('const id = "#main-content"; const t = "text-red-100";')).toEqual([]);
  });

  it("confines chromatic utilities to the business-semantic allowlist (item 13)", () => {
    const countUtilities = (stripped: string) => {
      const counts: Record<string, number> = {};
      for (const match of stripped.matchAll(COLORED_UTILITY)) {
        counts[match[0]] = (counts[match[0]] ?? 0) + 1;
      }
      return counts;
    };
    const actual: Record<string, Record<string, number>> = {};
    for (const { path, source } of adminSourceFiles) {
      const stripped = path.endsWith(".css") ? stripCssComments(source) : stripJsComments(source);
      const counts = countUtilities(stripped);
      if (Object.keys(counts).length > 0) actual[path] = counts;
      expect(arbitraryColorViolations(stripped), `${path}: arbitrary-value color utilities are banned`).toEqual([]);
    }
    // Deep equality is two-way AND per-occurrence: a chromatic utility outside
    // the allowlist, a stale allowlist entry, and an EXTRA occurrence of an
    // already-allowed utility (chrome re-use of a semantic color) all fail.
    expect(actual).toEqual(ADMIN_COLORED_UTILITY_ALLOWLIST);
    // Detector self-test: variant prefixes and opacity suffixes are matched;
    // duplicate occurrences are counted, not de-duplicated.
    expect([..."dark:text-amber-100 hover:bg-orange-100/50".matchAll(COLORED_UTILITY)].map((m) => m[0]))
      .toEqual(["text-amber-100", "bg-orange-100/50"]);
    // Scale-less direct colors are in the grammar; identifier collisions stay out.
    expect([..."bg-black/80 text-white border-black".matchAll(COLORED_UTILITY)].map((m) => m[0]))
      .toEqual(["bg-black/80", "text-white", "border-black"]);
    expect(countUtilities('"bg-blacklist text-white-space"')).toEqual({});
    // Tailwind 4.3 palettes, logical border sides, and scrollbar channels are
    // in the grammar (families derived from theme.css, not hand-kept).
    expect(TAILWIND_COLOR_FAMILIES).toEqual(expect.arrayContaining(["mauve", "mist", "olive", "taupe"]));
    expect(countUtilities('"bg-mauve-500 text-olive-500/50 border-bs-red-500 scrollbar-thumb-red-500 scrollbar-track-mist-100"')).toEqual({
      "bg-mauve-500": 1, "text-olive-500/50": 1, "border-bs-red-500": 1,
      "scrollbar-thumb-red-500": 1, "scrollbar-track-mist-100": 1
    });
    expect(countUtilities('cn("text-amber-600", open && "text-amber-600")')).toEqual({ "text-amber-600": 2 });
    // Directional / offset / inset color channels are part of the grammar.
    expect(countUtilities('"border-t-red-500 ring-offset-red-500 placeholder-red-500"')).toEqual({
      "border-t-red-500": 1, "ring-offset-red-500": 1, "placeholder-red-500": 1
    });
    // Arbitrary-value escape hatches (codex PR-G2 bypass fixtures): color-typed
    // values, chromatic roots with ANY value (keyword / var()), and
    // arbitrary-property color classes are all flagged…
    expect(arbitraryColorViolations("bg-[#ff0000] text-[oklch(0.5_0.1_200)]")).toHaveLength(2);
    expect(arbitraryColorViolations('"bg-[red]"')).toEqual(["bg-[red]"]);
    expect(arbitraryColorViolations('"bg-[var(--mg-paper)]"')).toEqual(["bg-[var(--mg-paper)]"]);
    expect(arbitraryColorViolations('"[color:red]"')).toEqual(["[color:red]"]);
    expect(arbitraryColorViolations('"hover:shadow-[0_0_0_1px_red]"')).toEqual(["shadow-[0_0_0_1px_red]"]);
    expect(arbitraryColorViolations('"border-t-[red] ring-offset-[red] placeholder-[red]"'))
      .toEqual(["border-t-[red]", "ring-offset-[red]", "placeholder-[red]"]);
    // Tailwind v4 CSS-variable shorthand and the shadow-family channels
    // generate CSS too (codex PR-G2 bypass fixtures).
    expect(arbitraryColorViolations('"bg-(--probe) border-t-(--probe) ring-offset-(--probe) placeholder-(--probe)"'))
      .toEqual(["bg-(--probe)", "border-t-(--probe)", "ring-offset-(--probe)", "placeholder-(--probe)"]);
    expect(arbitraryColorViolations('"drop-shadow-[0_0_1px_red] text-shadow-[0_0_1px_red]"'))
      .toEqual(["drop-shadow-[0_0_1px_red]", "text-shadow-[0_0_1px_red]"]);
    // Arbitrary-PROPERTY spellings of the same channels (codex PR-G2 bypass).
    expect(arbitraryColorViolations('"[text-shadow:0_0_1px_red] [filter:drop-shadow(0_0_1px_red)]"'))
      .toEqual(["[text-shadow:0_0_1px_red]", "[filter:drop-shadow(0_0_1px_red)]"]);
    // Utility spellings of the filter family, vendor/enumeration-escaping
    // color properties, and var() routes through color-bearing properties.
    expect(arbitraryColorViolations('"filter-[drop-shadow(0_0_1px_red)] backdrop-filter-[drop-shadow(0_0_1px_red)]"'))
      .toEqual(["filter-[drop-shadow(0_0_1px_red)]", "backdrop-filter-[drop-shadow(0_0_1px_red)]"]);
    expect(arbitraryColorViolations('"[-webkit-text-fill-color:red] [text-emphasis-color:red] [scrollbar-color:red_blue]"'))
      .toEqual(["[-webkit-text-fill-color:red]", "[text-emphasis-color:red]", "[scrollbar-color:red_blue]"]);
    expect(arbitraryColorViolations('"[box-shadow:var(--x)] [color:var(--mg-paper)]"'))
      .toEqual(["[box-shadow:var(--x)]", "[color:var(--mg-paper)]"]);
    // Custom properties, UPPERCASE vendor spellings, and color-accepting
    // shorthands with var() values (codex PR-G2 bypasses — Tailwind 4.3.3
    // generates all of these verbatim).
    expect(arbitraryColorViolations('"[--raw:red] [-WEBKIT-TEXT-FILL-COLOR:red]"'))
      .toEqual(["[--raw:red]", "[-WEBKIT-TEXT-FILL-COLOR:red]"]);
    expect(arbitraryColorViolations('"[border:var(--mg-paper)] [outline:var(--mg-paper)] [text-decoration:var(--mg-paper)]"'))
      .toEqual(["[border:var(--mg-paper)]", "[outline:var(--mg-paper)]", "[text-decoration:var(--mg-paper)]"]);
    // Property-name-independent raw-token route: ANY var(--mg-…) value fails,
    // whatever shorthand carries it (codex PR-G2 — same shape as above).
    expect(arbitraryColorViolations('"[text-emphasis:var(--mg-paper)] [-webkit-text-stroke:var(--mg-paper)]"'))
      .toEqual(["[text-emphasis:var(--mg-paper)]", "[-webkit-text-stroke:var(--mg-paper)]"]);
    // Non-color property/value pairs and variant selectors stay allowed —
    // including custom properties with non-color values.
    expect(arbitraryColorViolations('"[mask-type:luminance] supports-[backdrop-filter]:bg-muted data-[state=open]:bg-muted"'))
      .toEqual([]);
    expect(arbitraryColorViolations('"[--panel-gap:12px] [grid-template-columns:1fr_2fr]"')).toEqual([]);
    expect(arbitraryColorViolations('"w-(--sidebar-width) max-h-(--radix-popover-content-available-height)"')).toEqual([]);
    // …while non-chromatic arbitrary values (sizes, animation names, Radix
    // vars, tap-highlight variants) pass.
    expect(arbitraryColorViolations(
      '"transition-[color,background-color,border-color,box-shadow,scale] h-[var(--radix-select-trigger-height)] ' +
      'max-h-[60vh] translate-x-[-50%] slide-in-from-top-[48%] data-[state=open]:bg-muted ' +
      'motion-safe:animate-[empty-state-in_200ms_ease-out] w-[1px] rounded-[inherit]"'
    )).toEqual([]);
  });

  it("pins data-duration-geometry to the FR-008-sanctioned components", () => {
    // The browser gate trusts the attribute's self-declaration; this static
    // pin is what makes that trust safe — adding the attribute to any other
    // component (or another site in these) fails until FR-008 and this
    // expectation are amended together.
    const actual: Record<string, number> = {};
    for (const { path, source } of adminSourceFiles) {
      const count = [...stripJsComments(source).matchAll(/data-duration-geometry/g)].length;
      if (count > 0) actual[path] = count;
    }
    expect(actual).toEqual({
      "admin-app/src/components/schedule/reservation-card.tsx": 1,
      "admin-app/src/components/schedule/external-block-card.tsx": 3,
      // 単体テストが marker の存在を assert する selector (免除サイトの追加ではない)。
      "admin-app/src/components/schedule/external-block-card.test.tsx": 1,
      "admin-app/src/components/schedule/timeline-column.tsx": 1
    });
  });
});
