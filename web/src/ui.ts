/**
 * Tiny DOM helpers shared by the views. Everything from the chain goes in as text nodes, never as
 * HTML, so token names and memos can't inject markup.
 */
import { NETWORKS, type NetConfig } from "./config";
import { loadFailure } from "./proofcopy";
import type { LockStatus } from "./verify";

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;

export function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return el;
}

let pageNumber = 0;

/** Called by the router each time it renders a page. */
export function startPage() {
  pageNumber++;
}

/**
 * Captures the page being shown. The returned check turns false once the router renders another
 * page, so a flow started here never sends, navigates or reloads after the user has left.
 */
export function onThisPage(): () => boolean {
  const n = pageNumber;
  return () => n === pageNumber;
}

/** Shortens a long address for display; the full value stays in the title and copy button. */
export function short(id: string, keep = 8): string {
  const [prefix, rest] = id.includes("_") ? [id.slice(0, id.indexOf("_") + 1), id.slice(id.indexOf("_") + 1)] : ["", id];
  return rest.length <= keep * 2 + 1 ? id : `${prefix}${rest.slice(0, keep)}…${rest.slice(-keep)}`;
}

export function link(net: NetConfig, path: string, text: Child, cls?: string): HTMLElement {
  return h("a", { href: `#/${net.name}/${path}`, class: cls }, text);
}

export function copyButton(value: string, label = "Copy"): HTMLElement {
  const b = h("button", { class: "ghost small", type: "button", title: value }, label);
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Copy failed";
    }
    setTimeout(() => (b.textContent = label), 1500);
  });
  return b;
}

export function addressLine(value: string, net?: NetConfig, path?: string): HTMLElement {
  const text = h("code", { title: value }, short(value));
  return h("span", { class: "addr" }, net && path ? link(net, path, text) : text, copyButton(value));
}

/** "about 3 days" for a number of epochs. Epoch length varies, so this is an estimate. */
export function epochsAsDuration(net: NetConfig, epochs: number): string {
  const minutes = Math.abs(epochs) * net.epochMinutes.typical;
  if (minutes < 90) return `about ${Math.max(1, Math.round(minutes))} minutes`;
  const hours = minutes / 60;
  if (hours < 48) return `about ${Math.round(hours)} hours`;
  const days = hours / 24;
  if (days < 60) return `about ${Math.round(days)} days`;
  const months = days / 30.44;
  if (months < 24) return `about ${Math.round(months)} months`;
  return `about ${(days / 365.25).toFixed(1)} years`;
}

/** The viewer's offset from UTC at that moment, e.g. "UTC+5:30", "UTC-4" or "UTC". */
export function tzLabel(ms: number): string {
  const off = -new Date(ms).getTimezoneOffset();
  if (off === 0) return "UTC";
  const a = Math.abs(off);
  return `UTC${off > 0 ? "+" : "-"}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`;
}

/** A date and time in the viewer's locale with its timezone, e.g. "9 Nov 2026, 14:05 UTC+5:30". */
export function formatDate(ms: number): string {
  return `${new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} ${tzLabel(ms)}`;
}

/** When `epoch` most likely starts, at the network's typical epoch length. */
export function estimatedDate(net: NetConfig, epoch: number, currentEpoch: number): string {
  return formatDate(Date.now() + (epoch - currentEpoch) * net.epochMinutes.typical * 60_000);
}

/** A verdict-coloured pill (mint, amber, coral) or a neutral one. */
export function pill(text: string, kind: "ok" | "warn" | "bad" | "neutral"): HTMLElement {
  return h("span", { class: `pill ${kind}` }, text);
}

/** A lock's lifecycle (not a verdict), so it never uses the verdict colours. */
export function statusPill(status: LockStatus | null | undefined, unlocked = "Unlocked"): HTMLElement | string {
  if (status === "locked") return h("span", { class: "pill state-locked" }, "Locked");
  if (status === "claimable") return h("span", { class: "pill state-unlocked" }, unlocked);
  if (status === "claimed") return h("span", { class: "pill state-claimed" }, "Claimed");
  return "—";
}

/** A lock's verdict as a pill, for tables. */
export function verdictPill(v: "verified" | "unverified" | "unknown"): HTMLElement {
  return v === "verified" ? pill("Verified", "ok") : v === "unknown" ? pill("Unknown", "warn") : pill("Not verified", "bad");
}

export function notice(kind: "info" | "warn" | "bad" | "ok", ...children: Child[]): HTMLElement {
  return h("div", { class: `notice ${kind}`, role: kind === "bad" ? "alert" : undefined }, ...children);
}

/** Builds an inline SVG from a fixed markup string in this file (never from chain data). */
function svg(markup: string): Element {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild!;
}

/** The Lockbox mark: a padlock with a check, used in the header. */
export function logo(): Element {
  return svg(
    `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><path d="M10 14v-4a6 6 0 0 1 12 0v4" fill="none" stroke="currentColor" stroke-width="3"/><rect x="5" y="13" width="22" height="16" rx="4" fill="currentColor"/><path d="M11.5 21l3 3 6-6.5" fill="none" stroke="var(--bg)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );
}

type Verdict = "ok" | "warn" | "bad";
const SEAL_GLYPH: Record<Verdict, string> = {
  ok: `<path d="M22 33.5l7 7 14-15.5" stroke-width="4.5"/>`,
  warn: `<path d="M32 20v15" stroke-width="4.5"/><path d="M32 43.5v.5" stroke-width="5.5"/>`,
  bad: `<path d="M24 24l16 16M40 24L24 40" stroke-width="4.5"/>`,
};

/** A notary-style seal for a verdict: ribbed ring, tinted disc, and a check, mark or cross. */
export function seal(kind: Verdict): Element {
  return svg(
    `<svg class="seal ${kind}" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="none" stroke="currentColor" stroke-width="5" stroke-dasharray="1.6 2.95" opacity="0.55"/><circle cx="32" cy="32" r="23" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="2"/><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${SEAL_GLYPH[kind]}</g></svg>`,
  );
}

/**
 * The verdict at the top of a proof: seal, a heading-level title and what it means. `lines` go
 * under the text beside the seal (summary, note); `extra` goes below, inside the same panel (e.g.
 * the lock's epoch track).
 */
export function verdictPanel(kind: Verdict, title: string, text: Child, lines: Child[] = [], extra?: Child): HTMLElement {
  const id = `verdict-${++verdictIds}`;
  return h(
    "section",
    { class: `verdict ${kind}`, role: kind === "bad" ? "alert" : undefined, "aria-labelledby": id },
    h(
      "div",
      { class: "verdict-head" },
      seal(kind),
      h("div", {}, h("h2", { class: "verdict-title", id }, title), h("p", { class: "verdict-text" }, text), ...lines),
    ),
    extra,
  );
}
let verdictIds = 0;

/** A page title with the "Copy link to this proof" action beside it. */
export function proofTitle(title: HTMLElement): HTMLElement {
  return h("div", { class: "title-row" }, title, copyButton(location.href, "Copy link to this proof"));
}

/**
 * A page that couldn't load, as a neutral panel (it is not a verdict on anything): nothing at the
 * requested address on this network, with a link to the same address on the other one; part of
 * what the proof needs missing (a vault, a launch record), or the indexer unreachable, with Retry.
 * `path` is the page's route without the network, e.g. `lock/<id>`.
 */
export function loadError(net: NetConfig, what: string, id: string, path: string, e: unknown): HTMLElement {
  const other = Object.values(NETWORKS).find((n) => n.name !== net.name);
  const kind = loadFailure(e, id);
  const retry = h("button", { type: "button", class: "ghost" }, "Retry");
  retry.addEventListener("click", () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  const back = link(net, "", "Check another address", "button ghost");
  const body =
    kind === "absent"
      ? [
          h("h1", {}, `No ${what} at `, h("code", { title: id }, short(id)), ` on ${net.label}.`),
          h("p", { class: "muted" }, "Check the address, or the network it was made on."),
          h("div", { class: "row" }, other ? h("a", { href: `#/${other.name}/${path}`, class: "button" }, `Look on ${other.label}`) : null, back),
        ]
      : kind === "incomplete"
        ? [
            h("h1", {}, `Couldn't read the complete proof on ${net.label}`),
            h(
              "p",
              { class: "muted" },
              `Something the proof of ${what} `,
              h("code", { title: id }, short(id)),
              " depends on wasn't found, so no verdict is shown. The indexer may be behind; try again in a minute.",
            ),
            h("div", { class: "row" }, retry, back),
          ]
        : [
            h("h1", {}, kind === "unreachable" ? "Couldn't reach the indexer" : `Couldn't load this ${what}`),
            h("p", { class: "muted" }, errorText(e)),
            h("div", { class: "row" }, retry, back),
          ];
  return h("section", { class: "panel load-error" }, ...body);
}

/** The numbered steps beside a wallet flow's intro, so the page says what will happen. */
export function flowSteps(...steps: string[]): HTMLElement {
  return h("ol", { class: "flow-steps", "aria-label": "What happens" }, ...steps.map((s) => h("li", {}, s)));
}

export function loading(text = "Loading…"): HTMLElement {
  return h("p", { class: "muted loading", "aria-live": "polite" }, text);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
