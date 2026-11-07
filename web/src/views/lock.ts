/** Proof page for one lock: what it holds, until when, for whom, and whether to trust it. */
import type { NetConfig } from "../config";
import { currentEpoch, getSubstate, indexerHost } from "../indexer";
import { loadLock, verdict, type LoadedLock } from "../lockdata";
import { addressLine, copyButton, epochsAsDuration, errorText, estimatedDate, h, link, loading, notice, pill } from "../ui";
import { formatAmount, type Check } from "../verify";
import { claimInstructions, connect, dryRun, getProvider, submit, walletNetwork } from "../wallet";

export async function lockView(net: NetConfig, id: string, root: HTMLElement) {
  root.append(h("p", { class: "crumb" }, link(net, "", "Lockbox"), " / lock"), loading());
  let epoch: number;
  let l: LoadedLock;
  try {
    epoch = await currentEpoch(net);
    l = await loadLock(net, id, epoch);
  } catch (e) {
    root.lastElementChild?.replaceWith(notice("bad", `Could not load this lock: ${errorText(e)}`));
    return;
  }
  root.lastElementChild?.remove();
  root.append(render(net, l, epoch));
}

function render(net: NetConfig, l: LoadedLock, epoch: number): HTMLElement {
  const s = l.reading.state;
  const v = verdict(l);
  const r = l.resource;
  const sym = r?.symbol ?? "tokens";
  const page = h("article", { class: "proof" });

  const banner =
    v === "verified"
      ? l.status === "claimed"
        ? notice("ok", h("strong", {}, "Verified lock, now claimed. "), "It held its tokens until the unlock epoch, and the beneficiary has claimed them.")
        : l.status === "claimable"
          ? notice("ok", h("strong", {}, "Verified lock, now unlocked. "), "The unlock epoch has passed; only the beneficiary can claim the tokens.")
          : notice("ok", h("strong", {}, "Verified lock. "), "Nobody can move these tokens before the unlock epoch, and the token's issuer cannot undo it.")
      : v === "unknown"
        ? notice("warn", h("strong", {}, "Unable to verify. "), "Some data could not be read; treat this lock as unverified.")
        : notice("bad", h("strong", {}, "Not verified. "), "See the failed checks below.");
  page.append(h("h1", {}, "Lock ", h("code", { class: "title-addr", title: l.id }, l.id.slice(10, 22))), banner);

  if (s) {
    const statusPill =
      l.status === "locked" ? pill("Locked", "ok") : l.status === "claimable" ? pill("Unlocked, not claimed", "warn") : pill("Claimed", "neutral");
    const left = s.unlockEpoch - epoch;
    const amountNow = l.vault?.amount;
    const div = r?.divisibility ?? 0;
    page.append(
      h(
        "dl",
        { class: "facts" },
        h("dt", {}, "Status"),
        h("dd", {}, statusPill),
        h("dt", {}, "Holding now"),
        h(
          "dd",
          { class: "big" },
          amountNow === null || amountNow === undefined
            ? l.vault?.nftCount !== null && l.vault?.nftCount !== undefined
              ? `${l.vault.nftCount} NFT(s)`
              : "unknown"
            : `${formatAmount(amountNow, div)} ${sym}`,
        ),
        h("dt", {}, "Originally locked"),
        h("dd", {}, `${formatAmount(s.lockedAmount, div)} ${sym}`),
        h("dt", {}, "Token"),
        h("dd", {}, l.vault ? addressLine(l.vault.resource, net, `token/${l.vault.resource}`) : "unknown"),
        h("dt", {}, "Unlocks at"),
        h(
          "dd",
          {},
          `epoch ${s.unlockEpoch}`,
          h(
            "span",
            { class: "muted" },
            left > 0
              ? ` · in ${left} epochs (${epochsAsDuration(net, left)}, around ${estimatedDate(net, s.unlockEpoch, epoch)})`
              : ` · reached ${-left} epochs ago`,
          ),
        ),
        h("dt", {}, "Beneficiary key"),
        h("dd", {}, addressLine(s.beneficiary)),
        h("dt", {}, "Locked at"),
        h("dd", {}, `epoch ${s.lockedAtEpoch}`),
        s.memo ? h("dt", {}, "Memo") : null,
        s.memo ? h("dd", { class: "memo" }, s.memo) : null,
      ),
    );
  }

  const tokenChecks: Check[] = r
    ? [
        { ok: r.lockRisks.length === 0, label: "The token's issuer cannot undo the lock", detail: r.lockRisks.join(" ") || undefined },
        ...r.notes.map((n) => ({ ok: true, label: n, detail: "Doesn't affect the lock." })),
      ]
    : [{ ok: false, label: "Token rules are readable" }];
  page.append(h("h2", {}, "Checks"), checkList([...l.reading.checks, ...tokenChecks]));

  page.append(
    h(
      "p",
      { class: "muted small" },
      `Read from ${indexerHost(net)} (${net.label}) at epoch ${epoch}. `,
      l.indexerVerified ? "The indexer marked every substate it returned as verified. " : "The indexer did not mark every substate as verified. ",
      "This page trusts that indexer; anyone can re-check with their own.",
    ),
    h("div", { class: "row" }, copyButton(location.href, "Copy link to this proof")),
  );

  // Claiming signs a call to this component, so only offer it for a genuine Lockbox.
  if (s && l.status === "claimable" && l.reading.genuine) page.append(claimBox(net, l));
  return page;
}

export function checkList(checks: Check[]): HTMLElement {
  return h(
    "ul",
    { class: "checks" },
    ...checks.map((c) =>
      h(
        "li",
        { class: c.ok ? "ok" : "bad" },
        h("span", { class: "mark", "aria-hidden": "true" }, c.ok ? "✓" : "✕"),
        h("span", { class: "sr" }, c.ok ? "Passed: " : "Failed: "),
        h("span", {}, c.label, c.detail ? h("span", { class: "muted" }, ` — ${c.detail}`) : null),
      ),
    ),
  );
}

/** Shown once the unlock epoch is reached: the beneficiary claims into their connected account. */
function claimBox(net: NetConfig, l: LoadedLock): HTMLElement {
  const status = h("p", { class: "muted", "aria-live": "polite" });
  const btn = h("button", { type: "button" }, "Connect wallet to claim");
  const box = h("section", { class: "card" }, h("h2", {}, "Claim"), h("p", {}, "Only the beneficiary's wallet can claim. The tokens go to the account you connect."), btn, status);
  btn.addEventListener("click", async () => {
    btn.setAttribute("disabled", "");
    try {
      const p = await getProvider();
      if (!p) throw new Error("Sapient wallet not found. Install it, or claim with lockbox-cli.");
      const wn = await walletNetwork(p);
      if (wn !== net.walletNetwork) throw new Error(`Your wallet is on ${wn}; this lock is on ${net.label}.`);
      const account = await connect(p);
      const acct = await getSubstate(net, account);
      const owner = (acct.value as any)?.Component?.header?.owner_rule?.ByPublicKey;
      if (String(owner).toLowerCase() !== l.reading.state!.beneficiary) {
        throw new Error("The connected account is not this lock's beneficiary.");
      }
      const ix = claimInstructions(net, account, l.id);
      status.textContent = "Checking with a dry run…";
      await dryRun(p, ix);
      await submit(p, ix, (t) => (status.textContent = t));
      status.textContent = "Claimed. Reloading…";
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      status.textContent = errorText(e);
      btn.removeAttribute("disabled");
    }
  });
  return box;
}
