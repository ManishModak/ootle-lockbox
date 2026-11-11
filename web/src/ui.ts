/**
 * Tiny DOM helpers shared by the views. Everything from the chain goes in as text nodes, never as
 * HTML, so token names and memos can't inject markup.
 */
import type { NetConfig } from "./config";

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

/** A date and time in the viewer's locale, e.g. "9 Nov 2026, 14:05". */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** When `epoch` most likely starts, at the network's typical epoch length. */
export function estimatedDate(net: NetConfig, epoch: number, currentEpoch: number): string {
  return formatDate(Date.now() + (epoch - currentEpoch) * net.epochMinutes.typical * 60_000);
}

export function pill(text: string, kind: "ok" | "warn" | "bad" | "neutral"): HTMLElement {
  return h("span", { class: `pill ${kind}` }, text);
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
 * The verdict at the top of a proof: seal, a one-line title and what it means. `extra` goes under
 * the text, inside the same panel (e.g. the lock's epoch track).
 */
export function verdictPanel(kind: Verdict, title: string, text: Child, extra?: Child): HTMLElement {
  return h(
    "section",
    { class: `verdict ${kind}`, role: kind === "bad" ? "alert" : undefined },
    h("div", { class: "verdict-head" }, seal(kind), h("div", {}, h("p", { class: "verdict-title" }, title), h("p", { class: "verdict-text" }, text))),
    extra,
  );
}

/** A page that couldn't load: what failed, why, and the way back to the lookup. */
export function loadError(net: NetConfig, title: string, e: unknown): HTMLElement {
  return h("div", {}, verdictPanel("bad", title, errorText(e)), h("p", {}, link(net, "", "Check another address", "button ghost")));
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
