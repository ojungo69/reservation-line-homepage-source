import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("public reservation frontend assets", () => {
  const indexHtml = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
  const stylesCss = readFileSync(join(process.cwd(), "public/styles.css"), "utf8");

  it("ships the public reservation form instead of the bootstrap placeholder", () => {
    expect(indexHtml).toContain("ExampleStudio 予約");
    expect(indexHtml).toContain("/app.js?v=20260911-webmcp-1");
    expect(indexHtml).toContain("/styles.css?v=20260802-glass-2");
    expect(appJs).toContain("https://static.line-scdn.net/liff/edge/2/sdk.js");
    expect(appJs).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    expect(indexHtml).not.toContain("Reservation system foundation is running");
  });

  it("delegates CSP enforcement to the worker response header", () => {
    expect(indexHtml).not.toContain('http-equiv="Content-Security-Policy"');
  });

  it("offers a recovery link to the reservations page when the reservation cap blocks booking", () => {
    // The link element exists (hidden by default) and points at the confirmation page,
    // and app.js reveals it only for the reservation_limit_reached failure
    // (全予約承認制で active_pending_exists は撤廃済み — 上限は per-customer cap のみ)。
    expect(indexHtml).toContain('id="pending-recovery"');
    const recovery = indexHtml.slice(
      indexHtml.indexOf('id="pending-recovery"'),
      indexHtml.indexOf('id="pending-recovery"') + 240
    );
    expect(recovery).toContain('href="/customer/reservations"');
    expect(appJs).toContain('setPendingRecoveryVisible(reason === "reservation_limit_reached")');
    expect(appJs).not.toContain("active_pending_exists");
  });

  it("shows the store and menu on the booking success panel, not just the time", () => {
    expect(indexHtml).toContain('id="success-store"');
    expect(indexHtml).toContain('id="success-menu"');
    // app.js fills them from the confirmed values.
    expect(appJs).toContain("elements.successStore");
    expect(appJs).toContain("elements.successMenu");
  });

  it("links every consent checkbox to its published document (clickwrap)", () => {
    // Each consent row must give the customer a way to actually READ the document
    // they are agreeing to — checkbox-without-text is not a valid clickwrap.
    for (const href of [
      "/legal/terms",
      "/legal/notice",
      "/legal/cancellation",
      "/legal/privacy",
      "/legal/notice#minor-guardian"
    ]) {
      expect(indexHtml, `consent link missing: ${href}`).toContain(
        `<a href="${href}" target="_blank" rel="noopener">`
      );
    }
    // FR-012: one consolidated required consent covering all four documents.
    expect(indexHtml).toContain(
      "利用規約・予約前確認事項・キャンセルポリシー・プライバシーポリシーに同意します"
    );
    // Links must sit OUTSIDE the <label> — a link inside the label would toggle
    // the checkbox when clicked. The label closes before the links span starts.
    const consentSection = indexHtml.slice(
      indexHtml.indexOf('class="group consent-group"'),
      indexHtml.indexOf("turnstile-area")
    );
    const rows = consentSection.split('class="consent-row"').slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const labelClose = row.indexOf("</label>");
      const linksStart = row.indexOf('class="consent-links"');
      expect(labelClose).toBeGreaterThan(-1);
      expect(linksStart).toBeGreaterThan(labelClose);
      expect(row.slice(0, labelClose)).not.toContain("<a ");
    }
  });

  it("ships a footer with links to all four legal documents", () => {
    const footer = indexHtml.slice(indexHtml.indexOf('class="site-footer"'));
    for (const href of [
      "/legal/terms",
      "/legal/privacy",
      "/legal/cancellation",
      "/legal/tokusho"
    ]) {
      expect(footer, `footer link missing: ${href}`).toContain(`href="${href}"`);
    }
  });

  it("maps the reservation_limit_reached failure reason to a customer-facing message", () => {
    expect(appJs).toContain("reservation_limit_reached");
    // Wording points at the self-service recovery link revealed alongside the error.
    expect(appJs).toContain("現在のご予約をご確認のうえ");
  });

  it("frames submit as a request that the store approves (全予約承認制)", () => {
    // ボタン/確認文言は「確定」ではなく「申し込み」— 承認までは確定しない。
    expect(indexHtml).toContain("予約を申し込む");
    expect(indexHtml).not.toContain("予約を確定する");
    expect(indexHtml).toContain("店舗が内容を確認・承認した時点で確定");
    // 受付と確定を区別し、LINE未達時も既存の本人確認ページへ案内する。
    expect(indexHtml).toContain("店舗の承認後に予約が確定します。");
    expect(indexHtml).toContain("LINEが届かない場合も");
    expect(indexHtml).not.toContain("LINEに確認メッセージをお送りします。");
  });

  it("links the successful reservation panel to the existing LIFF reservation page", () => {
    const successPanel = indexHtml.slice(
      indexHtml.indexOf('id="success-panel"'),
      indexHtml.indexOf("</section>", indexHtml.indexOf('id="success-panel"')),
    );
    expect(successPanel).toContain('href="/customer/reservations"');
    expect(successPanel).not.toMatch(/[?&](?:token|access_token|id_token)=/i);
  });

  it("keeps public JavaScript wired to public APIs without secret names", () => {
    for (const endpoint of [
      "/api/public/reservation-options",
      "/api/public/availability",
      "/api/public/reservation-gate",
      "/api/public/reservations"
    ]) {
      expect(appJs).toContain(endpoint);
    }
    expect(appJs).not.toContain("TURNSTILE_SECRET_KEY");
    expect(appJs).not.toContain("LINE_CHANNEL_SECRET");
    expect(appJs).not.toContain("LINE_MESSAGING_CHANNEL_ACCESS_TOKEN");
  });

  it("keeps the submit idempotency key stable across same-session retries", () => {
    expect(appJs).toContain("sessionStorage.getItem(IDEMPOTENCY_STORAGE_KEY)");
    expect(appJs).toContain("IDEMPOTENCY_SIGNATURE_STORAGE_KEY");
    expect(appJs).toContain("ensureIdempotencyKeyForSignature(signature)");
    expect(appJs).toContain("requestBody.idempotencyKey = ensureIdempotencyKeyForSignature(signature)");
    expect(appJs).toContain("rotateIdempotencyKey();");
    expect(appJs).toContain("setIdempotencySignature(\"\");");
    expect(appJs).not.toContain("idempotencyKey: crypto.randomUUID()");
  });

  it("clears stale slot selections while loading fresh availability", () => {
    expect(appJs).toContain("availabilityRequestId");
    expect(appJs).toContain("clearSlots(\"空き時間を確認中です…\")");
    expect(appJs).toContain("requestId !== state.availabilityRequestId");
  });

  it("clears stale slot selections immediately when booking inputs change", () => {
    const updateSection = appJs.slice(
      appJs.indexOf("const requestAvailabilityUpdate"),
      appJs.indexOf("const waitForGlobal")
    );
    expect(updateSection).toContain("clearSlots(");
    expect(updateSection.indexOf("clearSlots(")).toBeLessThan(updateSection.indexOf("globalThis.setTimeout"));
  });

  it("keeps internal resource assignment hidden and defers slow checks until needed", () => {
    expect(indexHtml).toContain("class=\"resource-field\" hidden");
    expect(indexHtml).not.toContain("担当枠");
    expect(indexHtml).toContain("本人確認");
    expect(indexHtml).not.toContain("LINE確認");
    expect(appJs).toContain("void loadAvailability();");
    expect(appJs).toContain("requestAvailabilityUpdate");
    expect(indexHtml).toContain("<select id=\"date\" name=\"date\" required disabled></select>");
    expect(appJs).toContain("populateDateOptions");
    expect(appJs).toContain("formatDateOptionLabel");
    expect(indexHtml).not.toContain("type=\"date\"");
    expect(appJs).toContain("readyForSecurityCheck");
    expect(appJs).toContain("void startTurnstileRender();");
    expect(appJs).not.toContain("setStatus(\"予約内容を入力してください\");\n    void loadAvailability();\n    void startTurnstileRender();");
  });

  it("lets customers choose multiple services without showing internal minutes for non-massage menus", () => {
    expect(indexHtml).toContain("id=\"services\"");
    expect(indexHtml).not.toContain("<select id=\"service\"");
    expect(appJs).toContain("selectedServiceIds");
    expect(appJs).toContain("serviceIds");
    expect(appJs).toContain("type = \"checkbox\"");
    expect(appJs).toContain("formatServiceLabel");
  });

  it("preconnects external CDN origins used by LIFF and Turnstile to reduce first-paint latency", () => {
    expect(indexHtml).toContain("rel=\"preconnect\" href=\"https://static.line-scdn.net\"");
    expect(indexHtml).toContain("rel=\"preconnect\" href=\"https://challenges.cloudflare.com\"");
  });

  it("associates the LINE auth status with its disabled buttons and submit with the status output", () => {
    expect(indexHtml).toContain("id=\"line-login\" type=\"button\" class=\"line-login-btn\" aria-describedby=\"line-state\"");
    expect(indexHtml).toContain("id=\"friendship\" type=\"button\" disabled aria-describedby=\"line-state\"");
    expect(indexHtml).toContain("id=\"submit\" type=\"submit\" disabled aria-describedby=\"status submit-hint billing-note\"");
    // The LINE auth status line is announced to assistive tech as it flips 未確認 → 確認中 → 済み.
    expect(indexHtml).toContain("id=\"line-state\" aria-live=\"polite\"");
  });

  it("uses E (not ES) for the decorative brand badge", () => {
    expect(indexHtml).toContain("<span>E</span>");
    expect(indexHtml).not.toContain("<span>ES</span>");
  });

  it("collapses the multi-select menu into a dropdown with summary trigger and removable tags", () => {
    // Trigger + popover + tag surfaces exist so the long menu list can stay collapsed.
    expect(indexHtml).toContain("id=\"services-trigger\"");
    // Disclosure pattern: aria-expanded + aria-controls (no menu-implying aria-haspopup).
    expect(indexHtml).toContain("aria-expanded=\"false\"");
    expect(indexHtml).toContain("aria-controls=\"services-popover\"");
    expect(indexHtml).not.toContain("aria-haspopup");
    expect(indexHtml).toContain("id=\"services-popover\"");
    expect(indexHtml).toContain("id=\"services-tags\"");
    // The grouped checkbox list (multi-select) is preserved inside the popover.
    expect(indexHtml).toContain("class=\"service-list\" id=\"services\"");
    expect(appJs).toContain("const updateServicesSummary");
    expect(appJs).toContain("const toggleServicesPopover");
    expect(appJs).toContain("const deselectService");
    // Selection is still read live from the checkboxes — multi-select is intact.
    expect(appJs).toContain("input[name='serviceIds']:checked");
    expect(appJs).toContain("件選択中");
  });

  it("morphs the LINE login button into a green checkmark state once identity is verified", () => {
    expect(indexHtml).toContain("class=\"line-login-check\"");
    expect(indexHtml).toContain("class=\"line-login-label\"");
    expect(appJs).toContain("const setLineVerifiedButton");
    expect(appJs).toContain("button.classList.toggle(\"verified\", verified)");
    expect(appJs).toContain("setLineVerifiedButton(true)");
    expect(appJs).toContain("setLineVerifiedButton(false)");
    // CSS drives the green login default and the verified morph (accessible greens —
    // the raw value now lives in glass-tokens.css, styles.css maps it via the alias).
    expect(stylesCss).toContain("--color-line: var(--mg-active-line)");
    expect(stylesCss).toContain("#line-login.verified");
    expect(stylesCss).toContain("@keyframes lineCheckDraw");
  });

  it("lets the customer re-authenticate if the submit-stage gate rejects expired LINE tokens", () => {
    // The verified button is disabled; a submit-time auth_failed must clear the context
    // and re-enable login so the customer is not trapped with stale credentials.
    // (The auth_failed handling lives in returnToIdentityStep, the submit-failure
    // helper extracted from actuallySubmitReservation.)
    const submitSection = appJs.slice(
      appJs.indexOf("const returnToIdentityStep"),
      appJs.indexOf("const startTurnstileRender")
    );
    expect(submitSection).toContain("reason === \"auth_failed\"");
    expect(submitSection).toContain("state.lineContext = null");
    expect(submitSection).toContain("setLineVerifiedButton(false)");
    // Only LINE-token failures force re-login; Turnstile/rate-limit keep the context.
    expect(submitSection).toContain("LINE_AUTH_REASONS.has(body.authReason)");
    expect(appJs).toContain("const LINE_AUTH_REASONS = new Set([");
    // A not-friend rejection must leave the friend-add retry button usable.
    expect(submitSection).toContain("elements.friendship.disabled = body.authReason !== \"line_not_friend\"");
    // Tone matches the form-stage gate: not-friend = warning, other LINE failures = danger.
    expect(submitSection).toContain("body.authReason === \"line_not_friend\" ? \"warning\" : \"danger\"");
    // The hidden checkbox's keyboard focus is surfaced on the visible chip.
    expect(stylesCss).toContain(".chip:focus-within");
  });

  it("defines success and warning status tones so positive feedback is visible", () => {
    // Previously only danger/ok tones were styled; success/warning silently rendered as grey.
    expect(stylesCss).toContain("[data-tone=\"success\"]");
    expect(stylesCss).toContain("[data-tone=\"warning\"]");
    // Error status (.status) must also turn red, not just .inline-state.
    expect(stylesCss).toContain(".status[data-tone=\"danger\"]");
    expect(appJs).toContain("setLineState(\"本人確認が完了しました\", \"success\")");
  });

  it("exposes the step progress to assistive tech and marks the current step", () => {
    // The step indicator must not be hidden from the accessibility tree
    // (decorative brand-media / success-icon may still be aria-hidden).
    expect(indexHtml).toContain("<nav class=\"step-progress glass-thin\" aria-label=\"予約ステップ\">");
    expect(indexHtml).not.toContain("aria-label=\"予約ステップ\" aria-hidden");
    expect(appJs).toContain("setAttribute(\"aria-current\", \"step\")");
  });

  it("renders the slot picker as a single-select radiogroup with a visible selected state", () => {
    expect(appJs).toContain("setAttribute(\"role\", \"radiogroup\")");
    expect(appJs).toContain("button.setAttribute(\"role\", \"radio\")");
    expect(appJs).toContain("button.setAttribute(\"aria-checked\", \"true\")");
    expect(appJs).toContain("button.classList.add(\"slot-selected\")");
    // The old toggle-button semantics must be gone.
    expect(appJs).not.toContain("aria-pressed");
  });

  it("hides menu duration and uses one shared formatter across chip, step-2 summary and confirm", () => {
    expect(appJs).toContain("const formatServiceLabel");
    // Treatment duration is intentionally stripped and never re-appended to the label.
    expect(appJs).not.toContain("service.durationMinutes");
    // The chip, step-2 summary and step-3 confirm panel all use the one shared formatter
    // (the chip shows the price as a second line, the summaries append it inline).
    expect(appJs).toContain("nameLine.textContent = formatServiceLabel(service)");
    expect(appJs).toContain("services.map((s) => formatServiceLabelWithPrice(s, storeServices)).join(\" + \")");
    expect(appJs).toContain("return formatServiceLabelWithPrice(s, storeServices);");
  });

  it("shows the admin-managed price label through shared helpers that tolerate missing values", () => {
    // null AND a missing priceLabel property (old cached options payloads) both mean "no price".
    expect(appJs).toContain("const servicePriceLabel");
    expect(appJs).toContain('typeof service.priceLabel === "string"');
    expect(appJs).toContain("const formatServiceLabelWithPrice");
    // The chip price line is rendered via textContent only (never innerHTML).
    expect(appJs).toContain("priceLine.textContent = price");
    expect(appJs).toContain('priceLine.className = "service-price"');
  });

  it("sends time/slot-conflict errors back to step 1 and other errors to step 2", () => {
    expect(appJs).toContain("requiresSlotReselect");
    const reselectBlock = appJs.slice(
      appJs.indexOf("SLOT_RESELECT_REASONS = new Set"),
      appJs.indexOf("const OPTION_RELOAD_REASONS")
    );
    for (const reason of ["slot_unavailable", "outside_business_hours", "store_closed", "invalid_time", "customer_time_conflict"]) {
      expect(reselectBlock, `SLOT_RESELECT_REASONS missing ${reason}`).toContain(reason);
    }
    const submitSection = appJs.slice(
      appJs.indexOf("const actuallySubmitReservation"),
      appJs.indexOf("const startTurnstileRender")
    );
    // Non-slot failures return to the identity step (Turnstile re-solves there).
    expect(submitSection).toContain("showIdentityStep()");
  });

  it("refreshes availability when the customer returns to the page", () => {
    expect(appJs).toContain('addEventListener("visibilitychange", refreshAvailabilityOnReturn)');
    expect(appJs).toContain('globalThis.addEventListener("focus", refreshAvailabilityOnReturn)');
    // Hidden tabs fetch nothing — the on-return refresh covers the staleness.
    expect(appJs).toContain("if (document.hidden) return;");
    // A locked-in slot must never be re-rendered away by an auto refresh.
    expect(appJs).toContain("&& !state.selectedSlot");
    // Quick alt-tabs don't refetch; only data older than one poll interval does.
    expect(appJs).toContain("now - state.availabilityLoadedAt < AVAILABILITY_POLL_INTERVAL_MS");
  });
});
