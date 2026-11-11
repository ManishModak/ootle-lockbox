/** Token page: the token's rules (what its issuer can still do) and every Lockbox lock holding it. */
import type { NetConfig } from "../config";
import { currentEpoch, getSubstate, indexerHost, lockCreatedEvents } from "../indexer";
import { loadLock, mapLimit, verdict, type LoadedLock } from "../lockdata";
import { lockedTotalLine, notesLine, tokenVerdict } from "../proofcopy";
import { addressLine, errorText, h, link, loadError, loading, notice, onThisPage, proofTitle, statusPill, verdictPanel, verdictPill } from "../ui";
import { formatAmount, lockedShare, readResource, type ResourceReading } from "../verify";
import { checkList, notesList } from "./lock";

// Upper bounds on reads per page view; past them the total is shown as a lower bound.
const MAX_EVENT_PAGES = 20;
const MAX_LOCKS = 200;

export async function tokenView(net: NetConfig, id: string, root: HTMLElement) {
  root.append(h("p", { class: "crumb" }, link(net, "", "Lockbox"), " / token"), loading());
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
  const total = h("p", { class: "verdict-summary" }, h("span", { class: "muted" }, "Counting what is still locked…"));
  const parts: (HTMLElement | null)[] = [
    proofTitle(h("h1", {}, title, r.symbol && r.name ? h("span", { class: "muted" }, ` (${r.symbol})`) : null)),
    h("p", { class: "title-sub" }, addressLine(id)),
    r.launchedBy && net.launchTemplate
      ? notice("info", "This token says it was launched with Launch Commitments. ", link(net, `launch/${id}`, "Check its launch proof"), ".")
      : null,
    verdictPanel(v.kind, v.title, v.text, [total, note ? h("p", { class: "verdict-note" }, note) : null]),
    r.lockRisks.length || r.notes.length
      ? h(
          "section",
          { class: "panel checks-panel" },
          r.lockRisks.length ? h("h2", {}, v.listTitle) : null,
          r.lockRisks.length ? checkList(r.lockRisks.map((x) => ({ ok: false, label: x }))) : null,
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
      h("dd", {}, r.totalSupply === null ? "not tracked" : `${formatAmount(r.totalSupply, r.divisibility)}`),
      h("dt", {}, "Type"),
      h("dd", {}, r.type),
      h("dt", {}, "Decimals"),
      h("dd", {}, String(r.divisibility)),
    ),
  );
  root.append(section, details);
  await showLocks(net, id, r, epoch, section, total);
}

/**
 * Finds and reads the token's locks into `section` and the still-locked line into `total`. A
 * failed lookup stays inside this section (the rest of the page is still true), with Retry.
 */
async function showLocks(net: NetConfig, id: string, r: ResourceReading, epoch: number, section: HTMLElement, total: HTMLElement) {
  const body = h("div", {}, loading("Looking for locks…"));
  section.replaceChildren(section.firstElementChild!, body);
  total.replaceChildren(h("span", { class: "muted" }, "Counting what is still locked…"));
  const here = onThisPage();
  try {
    const found = await lockCreatedEvents(net, MAX_EVENT_PAGES);
    const mine = found.events.filter((e) => e.resource === id);
    const events = mine.slice(0, MAX_LOCKS);
    const loaded = await mapLimit(events, 4, (e) => loadLock(net, e.lock, epoch).catch(() => null));
    if (!here()) return;
    const locks = loaded.filter((x): x is LoadedLock => x !== null);
    // Locks whose state or still-locked balance couldn't be read count as missing too.
    const unreadable = (l: LoadedLock) => l.reading.state === null || (l.reading.genuine && l.status === "locked" && l.vault?.amount == null);
    const failed = loaded.length - locks.length + locks.filter(unreadable).length;
    const complete = found.complete && mine.length === events.length && failed === 0;
    total.replaceChildren(...lockedTotal(locks, r.divisibility, r.symbol, r.totalSupply, complete));
    body.replaceChildren(lockTable(net, locks, r.divisibility, epoch));
    const gaps = [
      !found.complete || mine.length > events.length ? `Only the newest ${events.length} locks were read.` : "",
      failed ? `${failed} lock(s) could not be read.` : "",
    ].filter(Boolean);
    if (gaps.length) body.append(notice("warn", `${gaps.join(" ")} The locked total is at least the amount shown.`));
    body.append(h("p", { class: "muted small" }, `Read from ${indexerHost(net)} at epoch ${epoch}.`));
  } catch (e) {
    if (!here()) return;
    total.replaceChildren(h("strong", {}, "Locked total unavailable"), ": the locks of this token couldn't be looked up.");
    const retry = h("button", { type: "button", class: "ghost small" }, "Retry");
    retry.addEventListener("click", () => void showLocks(net, id, r, epoch, section, total));
    body.replaceChildren(
      h("div", { class: "panel load-error inline-error", role: "status" }, h("p", {}, h("strong", {}, "Couldn't look up the locks of this token. "), h("span", { class: "muted" }, errorText(e))), h("div", { class: "row" }, retry)),
    );
  }
}

/** The still-locked total of a token's locks. `complete` = every lock of the token was read. */
function lockedTotal(locks: LoadedLock[], div: number, symbol: string | null, supply: bigint | null, complete: boolean): (Node | string)[] {
  // Only genuine locks still before their unlock epoch count as locked supply.
  const lockedNow = locks
    .filter((l) => l.reading.genuine && l.status === "locked" && l.vault?.amount)
    .reduce((sum, l) => sum + (l.vault!.amount ?? 0n), 0n);
  const [lead, bold, rest] = lockedTotalLine({
    lockedNow,
    amount: `${formatAmount(lockedNow, div)} ${symbol ?? ""}`.trim(),
    share: lockedShare(lockedNow, supply),
    supplyTracked: supply !== null,
    found: locks.length,
    open: locks.filter((l) => l.status === "claimable" || l.status === "claimed").length,
    complete,
  });
  return [lead, h("strong", {}, bold), rest];
}

/** Locks as a table: each one's holding, unlock epoch, lifecycle and verdict. */
export function lockTable(net: NetConfig, locks: LoadedLock[], div: number | null, epoch: number): HTMLElement {
  if (locks.length === 0) return h("p", { class: "muted" }, "No Lockbox locks found yet.");
  const rows = locks.map((l) => {
    const s = l.reading.state;
    const d = l.resource?.divisibility ?? div ?? 0;
    return h(
      "tr",
      {},
      h("td", { "data-label": "Lock" }, link(net, `lock/${l.id}`, h("code", { title: l.id }, l.id.slice(10, 22)))),
      h("td", { class: "num", "data-label": "Holding" }, l.vault?.amount != null ? `${formatAmount(l.vault.amount, d)} ${l.resource?.symbol ?? ""}`.trim() : "—"),
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
