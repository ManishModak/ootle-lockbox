/** Token page: the token's rules (what its issuer can still do) and every Lockbox lock holding it. */
import type { NetConfig } from "../config";
import { currentEpoch, getSubstate, indexerHost, lockCreatedEvents } from "../indexer";
import { loadLock, mapLimit, verdict, type LoadedLock } from "../lockdata";
import { notesLine } from "../proofcopy";
import { addressLine, h, link, loadError, loading, notice, proofTitle, statusPill, verdictPanel, verdictPill } from "../ui";
import { formatAmount, lockedShare, readResource } from "../verify";
import { checkList, notesList } from "./lock";

// Upper bounds on reads per page view; past them the total is shown as a lower bound.
const MAX_EVENT_PAGES = 20;
const MAX_LOCKS = 200;

export async function tokenView(net: NetConfig, id: string, root: HTMLElement) {
  root.append(h("p", { class: "crumb" }, link(net, "", "Lockbox"), " / token"), loading());
  try {
    const [epoch, sub] = await Promise.all([currentEpoch(net), getSubstate(net, id)]);
    const r = readResource(sub.value);
    root.lastElementChild?.remove();
    if (!r) {
      root.append(notice("bad", "This address is not a token (resource) on this network."));
      return;
    }
    const title = r.name ?? r.symbol ?? "Token";
    const note = notesLine(r.notes, "locks");
    // Filled in once the locks are read: the live locked amount sits right under the verdict.
    const total = h("p", { class: "locked-total" }, h("span", { class: "muted" }, "Counting what is still locked…"));
    const parts: (HTMLElement | null)[] = [
      proofTitle(h("h1", {}, title, r.symbol && r.name ? h("span", { class: "muted" }, ` (${r.symbol})`) : null)),
      h("p", { class: "title-sub" }, addressLine(id)),
      r.launchedBy && net.launchTemplate
        ? notice("info", "This token says it was launched with Launch Commitments. ", link(net, `launch/${id}`, "Check its launch proof"), ".")
        : null,
      r.lockRisks.length === 0
        ? verdictPanel(
            "ok",
            "The issuer can't undo a lock",
            "This token has no owner and its recall, freeze, withdraw and deposit rules are fixed, so locks of it can be verified.",
            [note ? h("p", { class: "verdict-note" }, note) : null],
          )
        : verdictPanel("bad", "The issuer can undo a lock", "Locks of this token are never marked verified.", [note ? h("p", { class: "verdict-note" }, note) : null]),
      total,
      r.lockRisks.length || r.notes.length
        ? h(
            "section",
            { class: "panel checks-panel" },
            r.lockRisks.length ? h("h2", {}, "What the issuer can still do") : null,
            r.lockRisks.length ? checkList(r.lockRisks.map((x) => ({ ok: false, label: x }))) : null,
            r.notes.length ? notesList(r.notes, "Doesn't affect locks.") : null,
          )
        : null,
    ];
    root.append(...parts.filter((x): x is HTMLElement => x !== null));

    const section = h("section", { class: "recent" }, h("h2", {}, "Locks of this token"), loading("Looking for locks…"));
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
    const found = await lockCreatedEvents(net, MAX_EVENT_PAGES);
    const mine = found.events.filter((e) => e.resource === id);
    const events = mine.slice(0, MAX_LOCKS);
    const loaded = await mapLimit(events, 4, (e) => loadLock(net, e.lock, epoch).catch(() => null));
    const locks = loaded.filter((x): x is LoadedLock => x !== null);
    // Locks whose state or still-locked balance couldn't be read count as missing too.
    const unreadable = (l: LoadedLock) => l.reading.state === null || (l.reading.genuine && l.status === "locked" && l.vault?.amount == null);
    const failed = loaded.length - locks.length + locks.filter(unreadable).length;
    const complete = found.complete && mine.length === events.length && failed === 0;
    section.lastElementChild?.remove();
    total.replaceWith(lockedTotal(locks, r.divisibility, r.symbol, r.totalSupply, complete));
    section.append(lockTable(net, locks, r.divisibility, epoch));
    const gaps = [
      !found.complete || mine.length > events.length ? `Only the newest ${events.length} locks were read.` : "",
      failed ? `${failed} lock(s) could not be read.` : "",
    ].filter(Boolean);
    if (gaps.length) section.append(notice("warn", `${gaps.join(" ")} The locked total is at least the amount shown.`));
    section.append(h("p", { class: "muted small" }, `Read from ${indexerHost(net)} at epoch ${epoch}.`));
  } catch (e) {
    root.lastElementChild?.replaceWith(loadError(net, "token", id, `token/${id}`, e));
  }
}

/** The still-locked total of a token's locks. `complete` = every lock of the token was read. */
function lockedTotal(locks: LoadedLock[], div: number, symbol: string | null, supply: bigint | null, complete: boolean): HTMLElement {
  // Only genuine locks still before their unlock epoch count as locked supply.
  const lockedNow = locks
    .filter((l) => l.reading.genuine && l.status === "locked" && l.vault?.amount)
    .reduce((sum, l) => sum + (l.vault!.amount ?? 0n), 0n);
  const share = lockedShare(lockedNow, supply);
  return h(
    "p",
    { class: "locked-total" },
    complete ? "" : "At least ",
    h("strong", {}, `${formatAmount(lockedNow, div)} ${symbol ?? ""}`.trim()),
    " still locked in Lockbox",
    share ? ` (${complete ? "" : "at least "}${share} of supply)` : supply === null ? " (supply not tracked, so no share)" : "",
    ". Counts only genuine locks before their unlock epoch.",
  );
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
