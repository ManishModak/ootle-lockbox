/**
 * Launch proof page (`#/<network>/launch/<resource>`): what a Launch Commitments token guarantees,
 * as separate facts, plus the locks its creator declared at launch. Never says "safe".
 */
import type { NetConfig } from "../config";
import { currentEpoch, indexerHost } from "../indexer";
import type { Fact } from "../launch";
import { loadLaunch, verdict, type LoadedLaunch } from "../lockdata";
import { addressLine, errorText, h, link, loading, notice, pill } from "../ui";
import { formatAmount } from "../verify";
import { checkList } from "./lock";

export async function launchView(net: NetConfig, id: string, root: HTMLElement) {
  root.append(h("p", { class: "crumb" }, link(net, "", "Lockbox"), " / launch"));
  if (!net.launchTemplate) {
    root.append(notice("info", `Launch Commitments is not published on ${net.label} yet.`));
    return;
  }
  root.append(loading());
  let epoch: number;
  let l: LoadedLaunch;
  try {
    epoch = await currentEpoch(net);
    l = await loadLaunch(net, id, epoch);
  } catch (e) {
    root.lastElementChild?.replaceWith(notice("bad", `Could not load this token: ${errorText(e)}`));
    return;
  }
  root.lastElementChild?.remove();
  root.append(render(net, id, l, epoch));
}

const FACT_PILL: Record<Fact, [string, "ok" | "bad" | "warn"]> = {
  yes: ["Yes", "ok"],
  no: ["No", "bad"],
  unknown: ["Unable to verify", "warn"],
};

function render(net: NetConfig, id: string, l: LoadedLaunch, epoch: number): HTMLElement {
  const t = l.token;
  if (!t) return notice("bad", "This address is not a token (resource) on this network.");
  const page = h("article", { class: "proof" });
  const title = t.name ?? t.symbol ?? "Token";
  page.append(h("h1", {}, title, t.symbol && t.name ? h("span", { class: "muted" }, ` (${t.symbol})`) : null), h("p", {}, addressLine(id)));

  const p = l.proof;
  if (!p) {
    page.append(
      notice("info", "This token names no Launch Commitments record, so it wasn't launched here. ", link(net, `token/${id}`, "See what its issuer can still do"), "."),
    );
    return page;
  }

  page.append(
    p.issued === "yes"
      ? notice("ok", h("strong", {}, "Issued by Launch Commitments. "), "Each fact below was checked on chain just now.")
      : p.issued === "no"
        ? notice("bad", h("strong", {}, "Not a genuine Launch Commitments token. "), "See the failed checks below.")
        : notice("warn", h("strong", {}, "Unable to verify. "), "Some data could not be read; treat this token as unverified."),
  );

  const fact = (label: string, f: Fact, meaning: string) => [h("dt", {}, label), h("dd", {}, pill(...FACT_PILL[f]), h("span", { class: "muted" }, ` ${meaning}`))];
  const div = t.divisibility;
  const sym = t.symbol ?? "tokens";
  page.append(
    h(
      "dl",
      { class: "facts" },
      ...fact("Fixed supply", p.fixedSupply, "Nobody can mint or burn it."),
      ...fact("Rules frozen", p.rulesFrozen, "No owner, every rule and updater locked, no transfer hook."),
      ...fact("Issued by Launch Commitments", p.issued, "Its launch record and the token name each other."),
      ...fact("Locked at launch", p.lockedAtLaunch, "Each lock below is a genuine Lockbox lock this launch made, with these terms."),
      h("dt", {}, "Still locked now"),
      h(
        "dd",
        {},
        p.stillLocked === null
          ? p.lockedAtLaunch === "yes" || p.lockedAtLaunch === "unknown"
            ? pill("Unable to verify", "warn")
            : "—"
          : `${formatAmount(p.stillLocked, div)} ${sym}`,
        h("span", { class: "muted" }, " Locks open at their epoch, then their beneficiary can claim."),
      ),
      h("dt", {}, "Supply"),
      h("dd", {}, t.totalSupply === null ? "unknown" : `${formatAmount(t.totalSupply, div)} ${sym}`),
      h("dt", {}, "Launch record"),
      h("dd", {}, addressLine(l.recordId ?? "")),
      p.record ? h("dt", {}, "Launched at") : null,
      p.record ? h("dd", {}, `epoch ${p.record.createdAtEpoch}`) : null,
    ),
  );

  if (p.record) {
    const byId = new Map(l.locks.map((x) => [x.id, x]));
    const rows = p.record.locks.map((want) => {
      const got = byId.get(want.lock);
      const status = got?.status;
      const v = got ? verdict(got) : "unknown";
      return h(
        "tr",
        {},
        h("td", {}, link(net, `lock/${want.lock}`, h("code", { title: want.lock }, want.lock.slice(10, 22)))),
        h("td", { class: "num" }, `${formatAmount(want.amount, div)} ${sym}`),
        h("td", {}, `epoch ${want.unlockEpoch}${want.unlockEpoch > BigInt(epoch) ? ` (in ${want.unlockEpoch - BigInt(epoch)})` : ""}`),
        h("td", {}, h("code", { title: want.beneficiary }, `${want.beneficiary.slice(0, 8)}…`)),
        h(
          "td",
          {},
          status === "locked" ? pill("Locked", "ok") : status === "claimable" ? pill("Unlocked", "warn") : status === "claimed" ? pill("Claimed", "neutral") : "—",
          " ",
          v === "verified" ? pill("Verified", "ok") : v === "unknown" ? pill("Unknown", "warn") : pill("Not verified", "bad"),
        ),
      );
    });
    page.append(
      h("h2", {}, "Locked at launch"),
      h("p", { class: "muted" }, "The creator chose these allocations. They don't show who holds the rest of the supply."),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, h("th", {}, "Lock"), h("th", { class: "num" }, "Amount"), h("th", {}, "Unlocks"), h("th", {}, "Beneficiary"), h("th", {}, "Status"))),
          h("tbody", {}, ...rows),
        ),
      ),
    );
  }

  page.append(
    h("h2", {}, "Checks"),
    checkList(p.checks),
    h(
      "p",
      { class: "muted small" },
      `Read from ${indexerHost(net)} (${net.label}) at epoch ${epoch}. `,
      l.indexerVerified ? "The indexer marked every substate it returned as verified. " : "The indexer did not mark every substate as verified. ",
      "This page trusts that indexer; anyone can re-check with their own.",
    ),
  );
  return page;
}
