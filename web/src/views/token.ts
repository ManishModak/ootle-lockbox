/** Token page: the token's rules (what its issuer can still do) and every Lockbox lock holding it. */
import type { NetConfig } from "../config";
import { currentEpoch, getSubstate, indexerHost, lockCreatedEvents } from "../indexer";
import { loadLock, mapLimit, verdict, type LoadedLock } from "../lockdata";
import { lockedTotalLine, lockReadGaps, notesLine, tokenVerdict } from "../proofcopy";
import { addressLine, errorText, h, lineSkeleton, link, loadError, notice, onThisPage, proofSkeleton, proofTitle, reloadPage, statusPill, tableSkeleton, verdictPanel, verdictPill } from "../ui";
import { lockedShare, readResource, tokenAmount, type ResourceReading } from "../verify";
import { checkList, notesList } from "./lock";

// Upper bounds on reads per page view; past them the total is shown as a lower bound.
const MAX_EVENT_PAGES = 20;
const MAX_LOCKS = 200;

export async function tokenView(net: NetConfig, id: string, root: HTMLElement) {
  root.append(h("p", { class: "crumb" }, link(net, "", "Lockbox"), " / token"), proofSkeleton("Loading the token…"));
  let epoch: number;
  let r: ResourceReading | null;
  try {
    const [e, sub] = await Promise.all([currentEpoch(net), getSubstate(net, id)]);
    epoch = e;
    r = readResource(sub.value);
  } catch (e) {
    root.lastElementChild?.replaceWith(loadError(net, "token", id, `token/${id}`, e));
    return;
  }
  root.lastElementChild?.remove();
  if (!r) {
    root.append(notice("bad", "This address is not a token (resource) on this network."));
    return;
  }
  const title = r.name ?? r.symbol ?? "Token";
  const note = notesLine(r.notes, "locks");
  const v = tokenVerdict(r);
  // Filled in once the locks are read: the live locked amount sits in the verdict panel.
  const total = h("p", { class: "verdict-summary" }, lineSkeleton("Counting what is still locked…"));
  const parts: (HTMLElement | null)[] = [
    proofTitle(h("h1", {}, title, r.symbol && r.name ? h("span", { class: "muted" }, ` (${r.symbol})`) : null)),
    h("p", { class: "title-sub" }, addressLine(id)),
    r.launchedBy && net.launchTemplate
      ? notice("info", "This token says it was launched with Launch Commitments. ", link(net, `launch/${id}`, "Check its launch proof"), ".")
      : null,
    verdictPanel(v.kind, v.title, v.text, [total, note ? h("p", { class: "verdict-note" }, note) : null]),
    r.lockRisks.length || r.unreadable.length || r.notes.length
      ? h(
          "section",
          { class: "panel checks-panel" },
          // Issuer powers under the verdict's heading; unread rules always in their own list, never as powers.
          r.lockRisks.length ? h("h2", {}, v.listTitle) : null,
          r.lockRisks.length ? checkList(r.lockRisks.map((x) => ({ ok: false, label: x }))) : null,
          r.unreadable.length ? h(r.lockRisks.length ? "h3" : "h2", { class: r.lockRisks.length ? "sub-list" : undefined }, "Couldn't be read") : null,
          r.unreadable.length ? checkList(r.unreadable.map((x) => ({ ok: false, unknown: true, label: x }))) : null,
          r.notes.length ? notesList(r.notes, "Doesn't affect locks.") : null,
        )
      : null,
  ];
  root.append(...parts.filter((x): x is HTMLElement => x !== null));

  const section = h("section", { class: "recent" }, h("h2", {}, "Locks of this token"));
  const details = h(
    "section",
    {},
    h("h2", {}, "Token details"),
    h(
      "dl",
      { class: "stats" },
      h("dt", {}, "Supply"),
      h("dd", {}, r.totalSupply === null ? "not tracked" : tokenAmount(r.totalSupply, r.divisibility)),
      h("dt", {}, "Type"),
      h("dd", {}, r.type),
      h("dt", {}, "Decimals"),
      h("dd", {}, r.divisibility === null ? "unknown" : String(r.divisibility)),
    ),
  );
  root.append(section, details);
  await showLocks(net, id, r, epoch, section, total);
}

/**
 * Finds and reads the token's locks into `section` and the still-locked line into `total`. A
 * failed lookup stays inside this section (the rest of the page is still true); its Retry reloads
 * the whole page, so the epoch and token reading are as fresh as the locks.
 */
async function showLocks(net: NetConfig, id: string, r: ResourceReading, epoch: number, section: HTMLElement, total: HTMLElement) {
  const body = h("div", {}, tableSkeleton(LOCK_COLUMNS, "Looking for locks…"));
  section.append(body);
  const here = onThisPage();
  try {
    const found = await lockCreatedEvents(net, MAX_EVENT_PAGES);
    const mine = found.events.filter((e) => e.resource === id);
    const events = mine.slice(0, MAX_LOCKS);
    const loaded = await mapLimit(events, 4, (e) => loadLock(net, e.lock, epoch).catch(() => null));
    if (!here()) return;
    const locks = loaded.filter((x): x is LoadedLock => x !== null);
    const { failed, complete } = lockReadGaps(loaded, found.complete && mine.length === events.length);
    total.replaceChildren(...lockedTotal(locks, r.divisibility, r.symbol, r.totalSupply, complete));
    body.replaceChildren(lockTable(net, locks, epoch));
    const gaps = [
      !found.complete || mine.length > events.length ? `Only the newest ${events.length} locks were read.` : "",
      failed ? `${failed} lock(s) could not be read.` : "",
    ].filter(Boolean);
    // "At least the amount shown" only when an amount is shown; otherwise the line above says it's unavailable.
    const bound = lockedNowOf(locks) > 0n && r.divisibility !== null ? "The locked total is at least the amount shown." : "The locked total couldn't be determined.";
    if (gaps.length) body.append(notice("warn", `${gaps.join(" ")} ${bound}`));
    body.append(h("p", { class: "muted small" }, `Read from ${indexerHost(net)} at epoch ${epoch}.`));
  } catch (e) {
    if (!here()) return;
    total.replaceChildren(h("strong", {}, "Locked total unavailable"), ": the locks of this token couldn't be looked up.");
    const retry = h("button", { type: "button", class: "ghost small" }, "Retry");
    retry.addEventListener("click", reloadPage);
    body.replaceChildren(
      h("div", { class: "panel load-error inline-error", role: "status" }, h("p", {}, h("strong", {}, "Couldn't look up the locks of this token. "), h("span", { class: "muted" }, errorText(e))), h("div", { class: "row" }, retry)),
    );
  }
}

/** The still-locked total of a token's locks. `complete` = every lock of the token was read. */
function lockedTotal(locks: LoadedLock[], div: number | null, symbol: string | null, supply: bigint | null, complete: boolean): (Node | string)[] {
  const lockedNow = lockedNowOf(locks);
  const [lead, bold, rest] = lockedTotalLine({
    lockedNow,
    amount: div === null ? null : tokenAmount(lockedNow, div, symbol ?? ""),
    share: lockedShare(lockedNow, supply),
    supplyTracked: supply !== null,
    found: locks.length,
    open: locks.filter((l) => l.status === "claimable" || l.status === "claimed").length,
    complete,
  });
  return [lead, h("strong", {}, bold), rest];
}

/** Only genuine locks still before their unlock epoch count as locked supply. */
function lockedNowOf(locks: LoadedLock[]): bigint {
  return locks.filter((l) => l.reading.genuine && l.status === "locked" && l.vault?.amount).reduce((sum, l) => sum + (l.vault!.amount ?? 0n), 0n);
}

/** The columns of a lock table, also used for its loading placeholder. */
export const LOCK_COLUMNS = ["Lock", "Holding", "Unlocks", "Status"];

/** Locks as a table: each one's holding (in its own token's precision), unlock epoch, lifecycle and verdict. */
export function lockTable(net: NetConfig, locks: LoadedLock[], epoch: number): HTMLElement {
  if (locks.length === 0) return h("p", { class: "muted" }, "No Lockbox locks found yet.");
  const rows = locks.map((l) => {
    const s = l.reading.state;
    return h(
      "tr",
      {},
      h("td", { "data-label": "Lock" }, link(net, `lock/${l.id}`, h("code", { title: l.id }, l.id.slice(10, 22)))),
      h("td", { class: "num", "data-label": "Holding" }, l.vault?.amount != null ? tokenAmount(l.vault.amount, l.resource?.divisibility ?? null, l.resource?.symbol ?? "") : "—"),
      h("td", { "data-label": "Unlocks" }, s ? `epoch ${s.unlockEpoch}${s.unlockEpoch > BigInt(epoch) ? ` (in ${s.unlockEpoch - BigInt(epoch)})` : ""}` : "—"),
      h("td", { class: "pills", "data-label": "Status" }, h("span", { class: "pill-group" }, statusPill(l.status), verdictPill(verdict(l)))),
    );
  });
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "stack" },
      h("thead", {}, h("tr", {}, h("th", {}, "Lock"), h("th", { class: "num" }, "Holding"), h("th", {}, "Unlocks"), h("th", {}, "Status"))),
      h("tbody", {}, ...rows),
    ),
  );
}
