/**
 * Launch proof page (`#/<network>/launch/<resource>`): what a Launch Commitments token guarantees,
 * as separate facts, plus the locks its creator declared at launch. Never says "safe".
 */
import type { NetConfig } from "../config";
import { currentEpoch, indexerHost } from "../indexer";
import type { Fact } from "../launch";
import { loadLaunch, verdict, type LoadedLaunch, type LoadedLock } from "../lockdata";
import { factText, launchVerdict, stillLockedText, type LaunchFactName } from "../proofcopy";
import { addressLine, h, link, loadError, loading, notice, pill, proofTitle, statusPill, verdictPanel, verdictPill } from "../ui";
import { tokenAmount } from "../verify";
import { checksSection } from "./lock";
import { notPublishedNotice } from "./home";

/** The small product label above a Launch Commitments page title. */
export function launchEyebrow(): HTMLElement {
  return h("p", { class: "eyebrow" }, "Launch Commitments");
}

/** The breadcrumb of a Launch Commitments page: the product links to its launch form. */
export function launchCrumb(net: NetConfig, here: string): HTMLElement {
  return h("p", { class: "crumb" }, link(net, "", "Lockbox"), " / ", link(net, "launch", "Launch Commitments"), ` / ${here}`);
}

export async function launchView(net: NetConfig, id: string, root: HTMLElement) {
  root.append(launchCrumb(net, "launch proof"));
  if (!net.launchTemplate) {
    root.append(launchEyebrow(), h("h1", {}, "Launch proof"), notPublishedNotice(net, "Launch Commitments", `launch/${id}`, "Look on Esmeralda testnet"));
    return;
  }
  root.append(loading());
  let epoch: number;
  let l: LoadedLaunch;
  try {
    epoch = await currentEpoch(net);
    l = await loadLaunch(net, id, epoch);
  } catch (e) {
    root.lastElementChild?.replaceWith(loadError(net, "token", id, `launch/${id}`, e));
    return;
  }
  root.lastElementChild?.remove();
  root.append(render(net, id, l, epoch));
}

/**
 * A launch lock's pill: a lock that failed this launch's check says so, even when it is a valid
 * Lockbox lock on its own (its lock page still shows that verdict); otherwise the lock's verdict.
 */
function launchLockPill(fromLaunch: Fact | undefined, got: LoadedLock | undefined): HTMLElement {
  if (fromLaunch === "no") return pill("Launch check failed", "bad");
  return verdictPill(got ? verdict(got) : "unknown");
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
  page.append(
    launchEyebrow(),
    proofTitle(h("h1", {}, title, t.symbol && t.name ? h("span", { class: "muted" }, ` (${t.symbol})`) : null)),
    h("p", { class: "title-sub" }, addressLine(id)),
  );

  const p = l.proof;
  if (!p) {
    page.append(
      notice("info", "This token names no Launch Commitments record, so it wasn't launched here. ", link(net, `token/${id}`, "See what its issuer can still do"), "."),
    );
    return page;
  }

  const div = t.divisibility;
  const sym = t.symbol ?? "tokens";
  const still = stillLockedText(p, div, sym, epoch);
  const v = launchVerdict(p);
  page.append(
    verdictPanel(v.kind, v.title, v.text, [
      // A zero says why in the seal itself, so "0 of …" never reads as a failure.
      still ? h("p", { class: "verdict-summary" }, "Still locked now: ", h("strong", {}, still.amount), p.stillLocked === 0n ? ` · ${still.note}` : null) : null,
    ]),
  );

  const fact = (label: string, name: LaunchFactName, f: Fact) => [
    h("dt", {}, label),
    h("dd", { class: "fact" }, pill(...FACT_PILL[f]), h("span", { class: "muted" }, factText(name, f, p.issued))),
  ];
  page.append(
    h(
      "dl",
      { class: "facts panel" },
      ...fact("Fixed supply", "fixedSupply", p.fixedSupply),
      ...fact("Rules frozen", "rulesFrozen", p.rulesFrozen),
      ...fact("Issued by Launch Commitments", "issued", p.issued),
      ...fact("Locked at launch", "lockedAtLaunch", p.lockedAtLaunch),
      h("dt", {}, "Still locked now"),
      still
        ? // A zero's note is already in the seal; don't repeat it here.
          h("dd", { class: "fact" }, h("strong", {}, still.amount), p.stillLocked === 0n ? null : h("span", { class: "muted" }, ` · ${still.note}`))
        : h("dd", { class: "fact" }, p.lockedAtLaunch === "yes" || p.lockedAtLaunch === "unknown" ? pill("Unable to verify", "warn") : "—"),
      h("dt", {}, "Supply"),
      h("dd", {}, t.totalSupply === null ? "unknown" : tokenAmount(t.totalSupply, div, sym)),
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
      return h(
        "tr",
        {},
        h("td", { "data-label": "Lock" }, link(net, `lock/${want.lock}`, h("code", { title: want.lock }, want.lock.slice(10, 22)))),
        h("td", { class: "num", "data-label": "Amount" }, tokenAmount(want.amount, div, sym)),
        h("td", { "data-label": "Unlocks" }, `epoch ${want.unlockEpoch}${want.unlockEpoch > BigInt(epoch) ? ` (in ${want.unlockEpoch - BigInt(epoch)})` : ""}`),
        h("td", { "data-label": "Beneficiary" }, h("code", { title: want.beneficiary }, `${want.beneficiary.slice(0, 8)}…`)),
        h("td", { class: "pills", "data-label": "Status" }, h("span", { class: "pill-group" }, statusPill(got?.status), launchLockPill(p.lockFacts.get(want.lock), got))),
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
          { class: "stack" },
          h("thead", {}, h("tr", {}, h("th", {}, "Lock"), h("th", { class: "num" }, "Amount"), h("th", {}, "Unlocks"), h("th", {}, "Beneficiary"), h("th", {}, "Status"))),
          h("tbody", {}, ...rows),
        ),
      ),
    );
  }

  page.append(
    checksSection(p.checks),
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
