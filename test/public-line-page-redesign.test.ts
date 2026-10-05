import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("LINE reservation page CSS", () => {
  const css = readFileSync("public/styles.css", "utf-8");

  it("defines --color-bg custom property", () => {
    expect(css).toContain("--color-bg");
  });

  it("defines .cta-btn class", () => {
    expect(css).toContain(".cta-btn");
  });

  it("defines .chip for menu selection", () => {
    expect(css).toContain(".chip");
  });

  it("renders menu choices as full-width mobile cards with wrapping labels", () => {
    const serviceListRule = css.match(/\.service-list\s*\{[\s\S]*?\}/)?.[0] ?? "";
    const chipRule = css.match(/\.chip\s*\{[\s\S]*?\}/)?.[0] ?? "";
    const chipTextRule = css.match(/\.chip span\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(serviceListRule).toContain("display: grid");
    expect(chipRule).toContain("width: 100%");
    expect(chipRule).toContain("grid-template-columns");
    expect(chipRule).toContain("min-height: var(--mg-touch-target)");
    expect(chipTextRule).toContain("overflow-wrap: anywhere");
  });

  it("defines .slot-button (required by app.js)", () => {
    expect(css).toContain(".slot-button");
  });

  it("gives slot buttons a visible keyboard focus ring", () => {
    expect(css).toContain(".slot-button:focus-visible");
  });

  it("uses a WCAG AA secondary text colour in light mode (>= 4.5:1 on white)", () => {
    // #6E6E73 on #FFFFFF = 4.9:1 (AA). The raw value lives in glass-tokens.css;
    // styles.css must route the semantic name through the active alias.
    const tokens = readFileSync("public/glass-tokens.css", "utf-8");
    expect(tokens).toContain("--mg-ink-secondary: #6E6E73;");
    const lightRoot = css.slice(0, css.indexOf("prefers-color-scheme: dark"));
    expect(lightRoot).toContain("--color-text-secondary: var(--mg-active-ink-secondary);");
  });

  it("has .skip-link for accessibility", () => {
    expect(css).toContain(".skip-link");
  });

  it("defines .step-num for step indicator", () => {
    expect(css).toContain(".step-num");
  });

  it("defines .step-connector", () => {
    expect(css).toContain(".step-connector");
  });

  it("keeps text inputs and selects at 16px to prevent iOS focus zoom", () => {
    // The 16px value is pinned as --mg-font-input in glass-tokens.css (functional
    // fixed size — token contract item 11); controls must consume it via var().
    const tokens = readFileSync("public/glass-tokens.css", "utf-8");
    expect(tokens).toContain("--mg-font-input: 16px;");
    const controlRule = css.match(
      /select,\s*input\[type="tel"\],\s*input\[type="text"\]\s*\{[\s\S]*?\}/
    )?.[0] ?? "";
    expect(controlRule).toContain("font-size: var(--mg-font-input)");
  });

  it("styles all step 2 and confirmation buttons as mobile touch targets", () => {
    for (const className of [".submit-button", ".back-button", ".auth-row button", ".success-new-btn"]) {
      expect(css, `missing ${className}`).toContain(className);
    }
    expect(css).toContain("min-height: var(--mg-touch-target)");
  });

  it("keeps hidden booking controls invisible even when button classes set display", () => {
    const hiddenRule = css.match(/\[hidden\]\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(hiddenRule).toContain("display: none !important");
  });

  it("does not float fieldset legends so consent check rows keep their width", () => {
    const groupLegendRule = css.match(/\.group legend\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(groupLegendRule).toContain("display: block");
    expect(groupLegendRule).toContain("float: none");
    expect(groupLegendRule).toContain("width: 100%");
  });

  it("allows long reservation summaries to wrap on narrow screens", () => {
    expect(css).toContain(".step2-val");
    expect(css).toContain(".confirm-dl dd");
    expect(css).toContain("overflow-wrap: anywhere");
  });

  it("does not clip the Turnstile widget on very narrow mobile screens", () => {
    const turnstileRule = css.match(/\.turnstile-area\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(turnstileRule).toContain("overflow-x: auto");
    expect(turnstileRule).not.toContain("overflow: hidden");
  });

  it("has dark mode support", () => {
    expect(css).toContain("prefers-color-scheme: dark");
  });

  it("has reduced-motion support", () => {
    expect(css).toContain("prefers-reduced-motion");
  });
});

describe("LINE reservation page HTML structure", () => {
  const html = readFileSync("public/index.html", "utf-8");

  it("has step-item elements with step-num and step-label", () => {
    expect(html).toContain('class="step-num"');
    expect(html).toContain('class="step-label"');
  });

  it("has step-connector elements between steps", () => {
    expect(html).toContain('class="step-connector"');
  });

  it("has brand-media logo element", () => {
    expect(html).toContain('class="brand-media"');
  });

  it("preserves all required JS hook IDs", () => {
    const requiredIds = [
      "reservation-form",
      "group-booking",
      "booking-edit",
      "services",
      "slots",
      "step1-next",
      "step2-content",
      "confirm-panel"
    ];
    for (const id of requiredIds) {
      expect(html, `missing id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it("has cta-btn class on next button", () => {
    expect(html).toContain('class="cta-btn"');
  });

  it("has step2-summary div", () => {
    expect(html).toContain('id="step2-summary"');
  });

  it("keeps a booking edit action without showing booking controls in step 2", () => {
    expect(html).toContain('id="booking-edit"');
    expect(html).toContain("予約内容を変更する");
  });

  it("keeps booking controls in a hideable first-step group", () => {
    expect(html).toContain('id="group-booking"');
    expect(html).toMatch(/<fieldset class="group" id="group-booking">[\s\S]*<span class="control-label"[^>]*>メニュー<\/span>[\s\S]*<select id="date"/);
  });

  it("opts into safe-area viewport handling for modern iPhones", () => {
    expect(html).toContain("viewport-fit=cover");
  });

  it("tags identity and consent fieldsets so the consent legend spacing fix is scoped", () => {
    expect(html).toContain('class="group identity-group"');
    expect(html).toContain('class="group consent-group"');
  });
});

describe("consent / identity fieldset CSS scoping", () => {
  const css = readFileSync("public/styles.css", "utf-8");

  it("scopes the gap-tightening to identity-group + consent-group, not all .group siblings", () => {
    expect(css).toMatch(/\.identity-group\s*\{[\s\S]{0,200}padding-bottom:\s*0\.5rem/);
    expect(css).toMatch(/\.identity-group\s+#line-state\s*\{[\s\S]{0,200}margin-bottom:\s*0/);
    expect(css).toMatch(/\.consent-group\s*\{[\s\S]{0,200}padding-top:\s*0\.25rem/);
    // ensure we did NOT introduce a blanket .group + .group rule which would
    // also tighten お客様情報→本人確認 (unrelated to the consent legend issue).
    expect(css).not.toMatch(/\.group\s*\+\s*\.group\b/);
  });
});

describe("app.js chip + step indicator", () => {
  const js = readFileSync("public/app.js", "utf-8");

  it("has updateStepIndicator function", () => {
    expect(js).toContain("updateStepIndicator");
  });

  it("has chip selected class toggle", () => {
    expect(js).toContain(".chip");
  });

  it("has step2-summary population logic", () => {
    expect(js).toContain("step2-summary");
  });

  it("hides booking controls when moving to the identity step", () => {
    expect(js).toContain("bookingGroup");
    expect(js).toContain("const showIdentityStep");
    expect(js).toContain("elements.bookingGroup.hidden = true");
    expect(js).toContain("const showBookingStep");
    expect(js).toContain("elements.bookingGroup.hidden = false");
  });

  it("scrolls to the top whenever the booking step is shown", () => {
    const bookingStep = js.slice(js.indexOf("const showBookingStep"), js.indexOf("const editBookingStep"));
    expect(bookingStep).toContain("scrollToPageTop()");
  });

  it("keeps an explicit path back to booking edits from the identity step", () => {
    expect(js).toContain("bookingEdit");
    expect(js).toContain("const editBookingStep");
    expect(js).toContain("elements.bookingEdit?.addEventListener");
  });

  it("uses textContent not innerHTML for step2 summary", () => {
    // Ensure user data goes through textContent (safe), not innerHTML
    const summarySection = js.slice(js.indexOf("step2-summary"), js.indexOf("step2-summary") + 500);
    expect(summarySection).not.toContain("innerHTML");
  });

  it("renders Turnstile in flexible size for responsive mobile layouts", () => {
    expect(js).toContain('size: "flexible"');
  });
});
