/** Token page: the token's rules (what its issuer can still do) and every Lockbox lock holding it. */
import type { NetConfig } from "../config";
import { currentEpoch, getSubstate, indexerHost, lockCreatedEvents } from "../indexer";
import { loadLock, mapLimit, verdict, type LoadedLock } from "../lockdata";
import { addressLine, errorText, h, link, loading, notice, pill } from "../ui";
import { formatAmount, lockedShare, readResource } from "../verify";
import { checkList } from "./lock";

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
    root.append(
      h("h1", {}, title, r.symbol && r.name ? h("span", { class: "muted" }, ` (${r.symbol})`) : null),
      h("p", {}, addressLine(id)),
      h(
        "dl",
        { class: "facts" },
        h("dt", {}, "Type"),
        h("dd", {}, r.type),
        h("dt", {}, "Supply"),
        h("dd", {}, r.totalSupply === null ? "not tracked" : `${formatAmount(r.totalSupply, r.divisibility)}`),
        h("dt", {}, "Decimals"),
        h("dd", {}, String(r.divisibility)),
      ),
      h("h2", {}, "Can the issuer undo a lock?"),
      r.lockRisks.length === 0
        ? notice("ok", "No. This token has no owner and its recall, freeze, withdraw and deposit rules are fixed, so locks of it can be verified.")
        : notice("bad", "Yes. Locks of this token are never marked verified."),
      checkList([
        ...r.lockRisks.map((x) => ({ ok: false, label: x })),
        ...r.notes.map((n) => ({ ok: true, label: n, detail: "Doesn't affect locks." })),
      ]),
    );

    const section = h("section", {}, h("h2", {}, "Locks of this token"), loading("Looking for locks…"));
    root.append(section);
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
    section.append(lockTable(net, locks, r.divisibility, r.totalSupply, epoch, complete));
    const gaps = [
      !found.complete || mine.length > events.length ? `Only the newest ${events.length} locks were read.` : "",
      failed ? `${failed} lock(s) could not be read.` : "",
    ].filter(Boolean);
    if (gaps.length) section.append(notice("warn", `${gaps.join(" ")} The locked total is at least the amount shown.`));
    section.append(h("p", { class: "muted small" }, `Read from ${indexerHost(net)} at epoch ${epoch}.`));
  } catch (e) {
    root.lastElementChild?.replaceWith(notice("bad", `Could not load this token: ${errorText(e)}`));
  }
}

/** Locks as a table, with the still-locked total. `complete` = every lock of the token was read. */
export function lockTable(net: NetConfig, locks: LoadedLock[], div: number | null, supply: bigint | null, epoch: number, complete: boolean): HTMLElement {
  if (locks.length === 0) return h("p", { class: "muted" }, "No Lockbox locks found yet.");
  // Only genuine locks still before their unlock epoch count as locked supply.
  const lockedNow = locks
    .filter((l) => l.reading.genuine && l.status === "locked" && l.vault?.amount)
    .reduce((sum, l) => sum + (l.vault!.amount ?? 0n), 0n);
  const share = div !== null ? lockedShare(lockedNow, supply) : null;
  const rows = locks.map((l) => {
    const s = l.reading.state;
    const d = l.resource?.divisibility ?? div ?? 0;
    const v = verdict(l);
    return h(
      "tr",
      {},
      h("td", {}, link(net, `lock/${l.id}`, h("code", { title: l.id }, l.id.slice(10, 22)))),
      h("td", { class: "num" }, l.vault?.amount != null ? `${formatAmount(l.vault.amount, d)} ${l.resource?.symbol ?? ""}`.trim() : "—"),
      h("td", {}, s ? `epoch ${s.unlockEpoch}${s.unlockEpoch > BigInt(epoch) ? ` (in ${s.unlockEpoch - BigInt(epoch)})` : ""}` : "—"),
      h(
        "td",
        {},
        l.status === "locked" ? pill("Locked", "ok") : l.status === "claimable" ? pill("Unlocked", "warn") : l.status === "claimed" ? pill("Claimed", "neutral") : "—",
        " ",
        v === "verified" ? pill("Verified", "ok") : v === "unknown" ? pill("Unknown", "warn") : pill("Not verified", "bad"),
      ),
    );
  });
  return h(
    "div",
    {},
    div !== null
      ? h(
          "p",
          {},
          complete ? "" : "At least ",
          h("strong", {}, `${formatAmount(lockedNow, div)} ${locks.find((l) => l.resource?.symbol)?.resource?.symbol ?? ""}`.trim()),
          " still locked",
          share ? ` (${complete ? "" : "at least "}${share} of supply)` : supply === null ? " (supply not tracked, so no share)" : "",
          ". Counts only genuine locks before their unlock epoch.",
        )
      : null,
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "Lock"), h("th", { class: "num" }, "Holding"), h("th", {}, "Unlocks"), h("th", {}, "Status"))),
        h("tbody", {}, ...rows),
      ),
    ),
  );
}

