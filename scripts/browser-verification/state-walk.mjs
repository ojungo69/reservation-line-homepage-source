// State-matrix walk driver (quickstart §2 — T022). Declarative manifest over
// preview-server.mjs's /?state= URLs: for each entry, navigate `url`, wait for
// `ready`, run the optional `actions` source (browser_evaluate), then
// screenshot + run a11y-scan.mjs (12px/44px) — per viewport (320/390) per
// color scheme (light/dark, emulated). Third parties can reproduce any single
// state by opening the URL in a plain browser; this file pins the walk order
// and the readiness/assertion criteria so the matrix is re-runnable.
//
// ready: { selector, text?, present? } — the element must exist (and contain
// text, when given) before evidence is captured. `present: true` waits for
// DOM presence instead of visibility — used to gate on renderServices()
// products that live inside the hidden popover (the statically-rendered
// #services-trigger proves nothing about /reservation-options having been
// applied). States listing `actionsSource` reach sub-states (open picker /
// confirm panel / done panel) with page-JS only.

export const STATE_WALK = [
  { state: "form-default", url: "/?state=form-default", ready: { selector: "#services input[name='serviceIds']", present: true } },
  {
    state: "form-default/picker-open",
    url: "/?state=form-default",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "openPicker",
    after: { selector: "#services-popover:not([hidden]) .services-search" }
  },
  {
    // While /options hangs the app has already replaced the boot message with
    // the LINE-account baseline and the store/menu fields sit empty — that IS
    // the deterministic loading view this state captures.
    state: "options-loading",
    url: "/?state=options-loading",
    ready: { selector: "#status", text: "ご予約はLINEアカウント" }
  },
  // Ready must prove the /options response was APPLIED, not just that the
  // always-present #status exists (a bare selector passes 21ms after load and
  // the scan photographs the initial view — fail-open).
  { state: "options-error", url: "/?state=options-error", ready: { selector: "#status", text: "予約画面を初期化できませんでした" } },
  { state: "options-empty", url: "/?state=options-empty", ready: { selector: "#store:disabled option", text: "選択できる店舗がありません" } },
  // The availability API only fires once store+menu+resource+date are set
  // (store/resource/date default on load), so these states MUST pick a menu —
  // without it the page shows the untouched default and the state is never
  // actually exercised.
  {
    state: "availability-loading",
    url: "/?state=availability-loading",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "pickMenu",
    after: { selector: "#slots[aria-busy='true']", text: "空き時間を確認中" }
  },
  {
    state: "availability-empty",
    url: "/?state=availability-empty",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "pickMenu",
    after: { selector: "#slots", text: "選択できる空き時間がありません" }
  },
  {
    state: "availability-error",
    url: "/?state=availability-error",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "pickMenu",
    after: { selector: "#slots", text: "空き時間を取得できませんでした" }
  },
  // Slot grid actually rendered — the action ALSO asserts the computed grid
  // resolves to exactly 4 tracks (research R11; 44px targets scanned at 320px)
  // — and the picker's selected-menu look (墨塗り + チェック).
  {
    state: "form-default/slots-visible",
    url: "/?state=form-default",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "pickMenuAssertGrid",
    after: { selector: ".slot-button" }
  },
  {
    state: "form-default/picker-selected",
    url: "/?state=form-default",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "selectInPicker",
    after: { selector: "#services-popover:not([hidden]) .service-option.selected" }
  },
  // FR-004 selected time slot (墨塗り) held as a FINAL state — the step-2
  // flows pass through it transiently, which never gets scanned.
  {
    state: "form-default/slot-selected",
    url: "/?state=form-default",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "selectSlot",
    after: { selector: ".slot-button.slot-selected" }
  },
  // FR-004 満席打ち消し: the availability API only returns FREE slots, so
  // `.slot-button:disabled` is defensive styling with no runtime trigger —
  // the walk flips the attribute to photograph it (quickstart §2 records
  // this spec correction).
  {
    state: "form-default/slot-disabled",
    url: "/?state=form-default",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "slotDisabled",
    after: { selector: ".slot-button:disabled" }
  },
  // FR-012: the single consolidated consent tick releases #submit — held as a
  // final state (reachConfirm only passes through it).
  {
    state: "form-default/consent-ready",
    url: "/?state=form-default",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "enableSubmit",
    after: { selector: "#submit:not([disabled])" }
  },
  {
    state: "line-logged-out",
    url: "/?state=line-logged-out",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "advanceStep2",
    after: { selector: "#line-login" }
  },
  {
    state: "dup-soft",
    url: "/?state=dup-soft",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "advanceStep2",
    after: { selector: "#duplicate-warning:not([hidden])" }
  },
  {
    state: "dup-hard",
    url: "/?state=dup-hard",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "advanceStep2",
    after: { selector: "#duplicate-warning:not([hidden])" }
  },
  {
    state: "dup-hard-pending",
    url: "/?state=dup-hard-pending",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "advanceStep2",
    after: { selector: "#duplicate-warning:not([hidden])", text: "既にご予約のお申し込み" }
  },
  // At the cap the step-1 #status carries the reason and 次へ stays disabled
  // by design, so step 2 (and its at-cap aside copy) is unreachable in the
  // browser — the aside copy is covered by the jsdom suite instead.
  { state: "cap", url: "/?state=cap", ready: { selector: "#status", text: "上限" } },
  {
    state: "submit-success/confirm",
    url: "/?state=submit-success",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "reachConfirm",
    after: { selector: "#confirm-panel:not([hidden])" }
  },
  {
    state: "submit-success/done",
    url: "/?state=submit-success",
    ready: { selector: "#services input[name='serviceIds']", present: true },
    actionsSource: "reachDone",
    after: { selector: "#success-panel:not([hidden])" }
  },
  { state: "my-loading", url: "/customer/reservations?state=my-loading", ready: { selector: "#status-banner", text: "読み込み中" } },
  { state: "my-error", url: "/customer/reservations?state=my-error", ready: { selector: "#status-banner[data-tone='error']" } },
  { state: "my-empty", url: "/customer/reservations?state=my-empty", ready: { selector: "#reservations", text: "現在ご利用可能な予約はありません" } },
  { state: "my-pending", url: "/customer/reservations?state=my-pending", ready: { selector: "#reservations .badge.pending" } },
  { state: "my-confirmed", url: "/customer/reservations?state=my-confirmed", ready: { selector: "#reservations .panel.surface" } },
  // Extensionless URLs — the production Worker contract (preview-server maps
  // /legal/<page> onto the static .html the same way).
  { state: "legal-terms", url: "/legal/terms", ready: { selector: "main" } },
  { state: "legal-notice", url: "/legal/notice", ready: { selector: "main" } },
  { state: "legal-cancellation", url: "/legal/cancellation", ready: { selector: "main" } },
  { state: "legal-privacy", url: "/legal/privacy", ready: { selector: "main" } },
  { state: "legal-tokusho", url: "/legal/tokusho", ready: { selector: "main" } }
];

// Action sources — evaluate as `(${source})()` after `ready` resolves. Each
// action is SELF-CONTAINED (the walker reloads the page per state), composed
// from shared snippets so the flows cannot drift apart.
const waitForSnippet = `
  const waitFor = async (predicate, timeoutMs = 6000) => {
    const start = performance.now();
    while (!predicate()) {
      if (performance.now() - start > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };`;

// Pick one menu → close the picker → click today's first slot.
const pickFlowSnippet = `
  const trigger = document.getElementById("services-trigger");
  if (document.getElementById("services-popover").hidden) trigger.click();
  const box = document.querySelector("#services input[name='serviceIds']");
  if (!box.checked) box.click();
  trigger.click();
  if (!(await waitFor(() => document.querySelector(".slot-button")))) return { error: "no slot rendered" };
  document.querySelector(".slot-button").click();`;

// Wait for the auto-verified form-stage gate (stub LIFF is logged in), tick
// the consolidated consent (+ duplicate acknowledgement when shown), submit,
// and wait for the confirm panel.
const consentSubmitSnippet = `
  if (!(await waitFor(() => /完了/.test(document.getElementById("line-state")?.textContent ?? "")))) {
    return { error: "gate did not resolve" };
  }
  const consent = document.getElementById("required-consent");
  consent.checked = true;
  consent.dispatchEvent(new Event("change", { bubbles: true }));
  const dup = document.getElementById("duplicate-consent");
  if (dup && !document.getElementById("duplicate-warning").hidden) {
    dup.checked = true;
    dup.dispatchEvent(new Event("change", { bubbles: true }));
  }
  document.getElementById("reservation-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  if (!(await waitFor(() => document.getElementById("confirm-panel").hidden === false))) {
    return { error: "confirm panel not shown" };
  }`;

export const ACTIONS = {
  openPicker: `async () => {
    document.getElementById("services-trigger").click();
    return document.getElementById("services-popover").hidden === false;
  }`,
  // Pick one menu and close the picker — store/resource/date default on load,
  // so this alone makes the availability request fire.
  pickMenu: `async () => {
    const trigger = document.getElementById("services-trigger");
    if (document.getElementById("services-popover").hidden) trigger.click();
    const box = document.querySelector("#services input[name='serviceIds']");
    if (!box) return { error: "no menu checkbox" };
    if (!box.checked) box.click();
    trigger.click();
    return true;
  }`,
  // pickMenu + assert the rendered slot grid computes to exactly 4 columns
  // (research R11) — a track-count regression must fail the walk, not just
  // look different in a screenshot.
  pickMenuAssertGrid: `async () => {${waitForSnippet}
    const trigger = document.getElementById("services-trigger");
    if (document.getElementById("services-popover").hidden) trigger.click();
    const box = document.querySelector("#services input[name='serviceIds']");
    if (!box) return { error: "no menu checkbox" };
    if (!box.checked) box.click();
    trigger.click();
    if (!(await waitFor(() => document.querySelector(".slot-button")))) return { error: "no slot rendered" };
    const tracks = getComputedStyle(document.getElementById("slots")).gridTemplateColumns.trim().split(/\\s+/).length;
    return tracks === 4 ? true : { error: "slot grid tracks: " + tracks };
  }`,
  // Pick a menu and click the first slot, staying on step 1 — the selected
  // slot look is the evidence.
  selectSlot: `async () => {${waitForSnippet}${pickFlowSnippet}
    return document.querySelector(".slot-button.slot-selected") ? true : { error: "slot not selected" };
  }`,
  // Render slots and force one disabled — the API never returns full slots
  // (see the STATE_WALK comment), so the attribute flip is the only way to
  // capture the FR-004 打ち消し style.
  slotDisabled: `async () => {${waitForSnippet}
    const trigger = document.getElementById("services-trigger");
    if (document.getElementById("services-popover").hidden) trigger.click();
    const box = document.querySelector("#services input[name='serviceIds']");
    if (!box) return { error: "no menu checkbox" };
    if (!box.checked) box.click();
    trigger.click();
    if (!(await waitFor(() => document.querySelectorAll(".slot-button").length >= 2))) return { error: "slots not rendered" };
    const second = document.querySelectorAll(".slot-button")[1];
    second.disabled = true;
    if (!second.matches(":disabled")) return { error: "disable did not stick" };
    const deco = getComputedStyle(second).textDecorationLine;
    return deco.includes("line-through") ? true : { error: "FR-004 strikethrough missing: " + deco };
  }`,
  // Advance to step 2, wait for the gate, tick the consolidated consent and
  // wait until #submit actually enables (stub Turnstile supplies the token).
  enableSubmit: `async () => {${waitForSnippet}${pickFlowSnippet}
    const next = document.getElementById("step1-next");
    if (!(await waitFor(() => !next.disabled))) return { error: "step1-next stayed disabled" };
    next.click();
    if (!(await waitFor(() => document.getElementById("step2-content").hidden === false))) return { error: "step2 not shown" };
    if (!(await waitFor(() => /完了/.test(document.getElementById("line-state")?.textContent ?? "")))) {
      return { error: "gate did not resolve" };
    }
    const consent = document.getElementById("required-consent");
    consent.checked = true;
    consent.dispatchEvent(new Event("change", { bubbles: true }));
    const enabled = await waitFor(() => !document.getElementById("submit").disabled);
    return enabled ? true : { error: "submit stayed disabled" };
  }`,
  // Same pick but leaving the popover OPEN: the selected-row look is the
  // evidence.
  selectInPicker: `async () => {
    const trigger = document.getElementById("services-trigger");
    if (document.getElementById("services-popover").hidden) trigger.click();
    const box = document.querySelector("#services input[name='serviceIds']");
    if (!box) return { error: "no menu checkbox" };
    if (!box.checked) box.click();
    return document.getElementById("services-popover").hidden === false;
  }`,
  // Step 2 hosts #line-login and #duplicate-warning (hidden ancestors on step
  // 1), so those states advance past 次へ before capturing evidence.
  advanceStep2: `async () => {${waitForSnippet}${pickFlowSnippet}
  const next = document.getElementById("step1-next");
  if (!(await waitFor(() => !next.disabled))) return { error: "step1-next stayed disabled" };
  next.click();
  const shown = await waitFor(() => document.getElementById("step2-content").hidden === false);
  return shown ? true : { error: "step2 not shown" };
  }`,
  reachConfirm: `async () => {${waitForSnippet}${pickFlowSnippet}${consentSubmitSnippet}
  return true;
  }`,
  reachDone: `async () => {${waitForSnippet}${pickFlowSnippet}${consentSubmitSnippet}
  document.getElementById("confirm-submit").click();
  const done = await waitFor(() => document.getElementById("success-panel")?.hidden === false, 8000);
  return done ? true : { error: "success panel not shown" };
  }`
};
