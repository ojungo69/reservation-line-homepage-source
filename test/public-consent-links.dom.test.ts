import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// Regression guard for the consent-row markup: the document links must live
// OUTSIDE the <label>. A link nested inside the label makes a click on
// 「利用規約を読む」 ALSO toggle the checkbox — the customer opens the document
// and unknowingly flips their consent state at the same time.

describe("consent document links vs checkbox state (JSDOM)", () => {
  const indexHtml = readFileSync(join(process.cwd(), "public/index.html"), "utf8");

  it("clicking a consent link never toggles its row's checkbox", () => {
    const dom = new JSDOM(indexHtml, { url: "https://reservation.test/" });
    const { document } = dom.window;

    // FR-012 consolidation: one required-consent row (4 document links) + the
    // independent minor-guardian row.
    const rows = [...document.querySelectorAll(".consent-row")];
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      const checkbox = row.querySelector<HTMLInputElement>("input[type='checkbox']");
      const links = [...row.querySelectorAll<HTMLAnchorElement>(".consent-links a")];
      expect(checkbox).not.toBeNull();
      expect(links.length).toBeGreaterThan(0);
      if (checkbox?.id === "required-consent") {
        const details = row.querySelector("details");
        expect(details?.open).toBe(false);
        expect(details?.closest("label")).toBeNull();
        expect(details?.querySelectorAll("a")).toHaveLength(4);
        details?.querySelector("summary")?.click();
        expect(checkbox.checked).toBe(false);
      }

      for (const link of links) {
        // Structural invariant: the anchor is not a descendant of the label.
        expect(link.closest("label")).toBeNull();

        // Behavioural check, both from unchecked and checked states.
        if (!checkbox) continue;
        checkbox.checked = false;
        link.click();
        expect(checkbox.checked, `${link.href} toggled an unchecked box`).toBe(false);
        checkbox.checked = true;
        link.click();
        expect(checkbox.checked, `${link.href} toggled a checked box`).toBe(true);
      }
    }
  });

  it("keeps the checkbox itself toggleable through its label", () => {
    const dom = new JSDOM(indexHtml, { url: "https://reservation.test/" });
    const { document } = dom.window;

    const label = document.querySelector<HTMLLabelElement>(".consent-row label.check");
    const checkbox = label?.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(label).not.toBeNull();
    expect(checkbox).not.toBeNull();
    if (!label || !checkbox) return;

    expect(checkbox.checked).toBe(false);
    label.click();
    expect(checkbox.checked).toBe(true);
  });
});
