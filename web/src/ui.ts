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

export function estimatedDate(net: NetConfig, epoch: number, currentEpoch: number): string {
  const ms = Date.now() + (epoch - currentEpoch) * net.epochMinutes.typical * 60_000;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function pill(text: string, kind: "ok" | "warn" | "bad" | "neutral"): HTMLElement {
  return h("span", { class: `pill ${kind}` }, text);
}

export function notice(kind: "info" | "warn" | "bad" | "ok", ...children: Child[]): HTMLElement {
  return h("div", { class: `notice ${kind}`, role: kind === "bad" ? "alert" : undefined }, ...children);
}

export function loading(text = "Loading…"): HTMLElement {
  return h("p", { class: "muted", "aria-live": "polite" }, text);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
