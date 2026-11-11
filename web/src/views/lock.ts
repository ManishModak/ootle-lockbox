/** Proof page for one lock: what it holds, until when, for whom, and whether to trust it. */
import type { NetConfig } from "../config";
import { currentEpoch, indexerHost } from "../indexer";
import { loadLock, verdict, type LoadedLock } from "../lockdata";
import { lockChecks, notesLine } from "../proofcopy";
import { addressLine, epochsAsDuration, errorText, estimatedDate, h, link, loadError, loading, onThisPage, proofTitle, short, statusPill, verdictPanel } from "../ui";
import { formatAmount, type Check } from "../verify";
import { claimInstructions, connect, dryRun, forgetEarlierTransaction, getProvider, settleEarlier, submit, TxBlocked, walletKey, requireWalletNetwork } from "../wallet";

/** Past this many epochs ahead (centuries at any epoch length) no date is estimated. */
const MAX_DATED_EPOCHS = 10_000_000n;

export async function lockView(net: NetConfig, id: string, root: HTMLElement) {
  root.append(h("p", { class: "crumb" }, link(net, "", "Lockbox"), " / lock"), loading());
  let epoch: number;
  let l: LoadedLock;
  try {
    epoch = await currentEpoch(net);
    l = await loadLock(net, id, epoch);
  } catch (e) {
    root.lastElementChild?.replaceWith(loadError(net, "lock", id, `lock/${id}`, e));
    return;
  }
  root.lastElementChild?.remove();
  root.append(render(net, l, epoch));
}

/** "unlocks at epoch N, around <date> <tz>" or "unlocked at epoch N", for the verdict summary. */
function unlockPhrase(net: NetConfig, unlockEpoch: bigint, epoch: number): string {
  const left = unlockEpoch - BigInt(epoch);
  if (left <= 0n) return `unlocked at epoch ${unlockEpoch}`;
  if (left > MAX_DATED_EPOCHS) return `unlocks at epoch ${unlockEpoch}, centuries away`;
  return `unlocks at epoch ${unlockEpoch}, around ${estimatedDate(net, Number(unlockEpoch), epoch)}`;
}

function render(net: NetConfig, l: LoadedLock, epoch: number): HTMLElement {
  const s = l.reading.state;
  const v = verdict(l);
  const r = l.resource;
  const sym = r?.symbol ?? "tokens";
  const div = r?.divisibility ?? 0;
  const { checks, notes } = lockChecks(l);
  const page = h("article", { class: "proof" });

  const summary = s
    ? h(
        "p",
        { class: "verdict-summary" },
        h("strong", {}, `${formatAmount(s.lockedAmount, div)} ${sym}`),
        " · beneficiary ",
        h("code", { title: s.beneficiary }, short(s.beneficiary)),
        ` · ${unlockPhrase(net, s.unlockEpoch, epoch)}`,
      )
    : null;
  const note = notesLine(notes, "the lock");
  // Claiming signs a call to this component, so only offer it for a genuine Lockbox. A verified
  // lock's claim comes right after its facts, with a shortcut to it in the verdict; otherwise the
  // claim comes only after the checks have been read.
  const claim = s && l.status === "claimable" && l.reading.genuine ? claimBox(net, l) : null;
  const goToClaim = () => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    claim?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
    claim?.querySelector("button")?.focus({ preventScroll: true });
  };
  const toClaim = claim && v === "verified" ? h("p", { class: "verdict-action" }, h("button", { type: "button", class: "small", onclick: goToClaim }, "Claim tokens")) : null;
  const lines = [summary, note ? h("p", { class: "verdict-note" }, note) : null, toClaim];
  const track = s ? epochTrack(s.lockedAtEpoch, s.unlockEpoch, epoch) : null;
  const banner =
    v === "verified"
      ? l.status === "claimed"
        ? verdictPanel("ok", "Verified lock, now claimed", "It held its tokens until the unlock epoch, and the beneficiary has claimed them.", lines, track)
        : l.status === "claimable"
          ? verdictPanel("ok", "Verified lock, now unlocked", "The unlock epoch has passed; only the beneficiary can claim the tokens.", lines, track)
          : verdictPanel("ok", "Verified lock", "Nobody can move these tokens before the unlock epoch, and the token's issuer cannot undo it.", lines, track)
      : v === "unknown"
        ? verdictPanel("warn", "Unable to verify", "Some data could not be read; treat this lock as unverified.", lines, track)
        : verdictPanel("bad", "Not verified", "See the failed checks below.", lines, track);
  page.append(
    proofTitle(h("h1", {}, "Lock ", h("code", { class: "title-addr", title: l.id }, l.id.slice(10, 22)))),
    h("p", { class: "title-sub" }, addressLine(l.id)),
    banner,
  );

  if (s) {
    const left = s.unlockEpoch - BigInt(epoch);
    const amountNow = l.vault?.amount;
    page.append(
      h(
        "dl",
        { class: "facts panel" },
        h("dt", {}, "Status"),
        h("dd", {}, statusPill(l.status, "Unlocked, not claimed")),
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
            left > MAX_DATED_EPOCHS
              ? ` · in ${left} epochs (centuries away)`
              : left > 0n
                ? ` · in ${left} epochs (${epochsAsDuration(net, Number(left))})`
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

  if (claim && v === "verified") page.append(claim);
  page.append(checksSection(checks, notes, "Doesn't affect the lock."));
  page.append(
    h(
      "p",
      { class: "muted small" },
      `Read from ${indexerHost(net)} (${net.label}) at epoch ${epoch}. `,
      l.indexerVerified ? "The indexer marked every substate it returned as verified. " : "The indexer did not mark every substate as verified. ",
      "This page trusts that indexer; anyone can re-check with their own.",
    ),
  );
  if (claim && v !== "verified") page.append(claim);
  return page;
}

export function checkList(checks: Check[]): HTMLElement {
  return h(
    "ul",
    { class: "checks" },
    ...checks.map((c) =>
      h(
        "li",
        { class: c.ok ? "ok" : c.unknown ? "unknown" : "bad" },
        h("span", { class: "mark", "aria-hidden": "true" }, c.ok ? "✓" : c.unknown ? "?" : "✕"),
        h("span", { class: "sr" }, c.ok ? "Passed: " : c.unknown ? "Couldn't check: " : "Failed: "),
        h("span", { class: "check-text" }, c.label, c.detail ? h("span", { class: "check-detail" }, c.detail) : null),
      ),
    ),
  );
}

/** A token's notes: things its issuer can still change that don't affect locks. Never counted as checks. */
export function notesList(notes: string[], detail: string): HTMLElement {
  return h(
    "div",
    { class: "notes" },
    h("h3", {}, "Notes"),
    h(
      "ul",
      { class: "checks" },
      ...notes.map((n) =>
        h(
          "li",
          { class: "note" },
          h("span", { class: "mark", "aria-hidden": "true" }, "i"),
          h("span", { class: "sr" }, "Note: "),
          h("span", { class: "check-text" }, n, h("span", { class: "check-detail" }, detail)),
        ),
      ),
    ),
  );
}

/** "Checks" with how many passed, then the list and any notes (not counted), as one panel on a proof page. */
export function checksSection(checks: Check[], notes: string[] = [], noteDetail = ""): HTMLElement {
  const passed = checks.filter((c) => c.ok).length;
  // Coral only when a check actually failed; checks that couldn't be read alone are amber.
  const tone = passed === checks.length ? "ok" : checks.some((c) => !c.ok && !c.unknown) ? "bad" : "warn";
  return h(
    "section",
    { class: "panel checks-panel" },
    h("div", { class: "checks-head" }, h("h2", {}, "Checks"), h("span", { class: `count ${tone}` }, `${passed} of ${checks.length} passed`)),
    checkList(checks),
    notes.length ? notesList(notes, noteDetail) : null,
  );
}

/**
 * The lock's span from its lock epoch to its unlock epoch. Before the unlock epoch a marker and a
 * "Now" label show where the chain is; after it, a caption below says how long ago it unlocked.
 * Visual only (the same epochs are in the summary and facts), so hidden from screen readers.
 */
function epochTrack(lockedAt: bigint, unlockAt: bigint, now: number): HTMLElement {
  const span = unlockAt - lockedAt;
  const done = BigInt(now) - lockedAt;
  const reached = BigInt(now) >= unlockAt;
  // Basis points, so huge u64 epochs never lose precision through Number.
  const bp = span <= 0n || done >= span ? 10000 : done <= 0n ? 0 : Number((done * 10000n) / span);
  const pct = `${bp / 100}%`;
  const ago = BigInt(now) - unlockAt;
  return h(
    "div",
    { class: "track", "aria-hidden": "true" },
    // Shifting the label left by its own position keeps it inside the bar at either end.
    reached ? null : h("div", { class: "track-now-row" }, h("span", { class: "track-now-label", style: `left: ${pct}; transform: translateX(-${pct})` }, "Now ", h("strong", {}, `epoch ${now}`))),
    h("div", { class: "track-bar" }, h("div", { class: "track-fill", style: `width: ${pct}` }), reached ? null : h("div", { class: "track-now", style: `left: ${pct}` })),
    h(
      "div",
      { class: "track-labels" },
      h("span", {}, "Locked at ", h("strong", {}, `epoch ${lockedAt}`)),
      h("span", {}, reached ? "Unlocked at " : "Unlocks at ", h("strong", {}, `epoch ${unlockAt}`)),
    ),
    reached
      ? h("p", { class: "track-caption" }, `${ago === 0n ? "Unlocked this epoch" : `Unlocked ${ago} epoch${ago === 1n ? "" : "s"} ago`} · now epoch ${now}`)
      : null,
  );
}

/**
 * Shows a failed create/claim in `status`. When an earlier transaction's outcome is unknown, adds
 * the deliberate way out: the user checks their wallet history, then forgets it here.
 */
export function showTxError(net: NetConfig, status: HTMLElement, e: unknown) {
  status.textContent = errorText(e);
  if (!(e instanceof TxBlocked && e.forgettable)) return;
  const requestId = e.forgettable;
  const forget = h("button", { type: "button", class: "ghost small" }, "I've checked my wallet: forget it");
  forget.addEventListener("click", async () => {
    try {
      await forgetEarlierTransaction(net, requestId);
      status.textContent = "Forgotten. You can try again.";
    } catch (err) {
      status.textContent = errorText(err);
    }
  });
  status.append(" ", forget);
}

/** Disables or re-enables every control of a form while a transaction it reviewed is in flight. */
export function setFormBusy(form: HTMLElement, busy: boolean) {
  form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, select, button").forEach((el) => (el.disabled = busy));
}

/** Shown once the unlock epoch is reached: the beneficiary claims into their connected account. */
function claimBox(net: NetConfig, l: LoadedLock): HTMLElement {
  const status = h("p", { class: "muted", "aria-live": "polite" });
  const btn = h("button", { type: "button" }, "Connect wallet to claim");
  const box = h("section", { class: "card claim", id: "claim" }, h("h2", {}, "Claim"), h("p", {}, "Only the beneficiary's wallet can claim. The tokens go to the account you connect."), btn, status);
  btn.addEventListener("click", async () => {
    btn.setAttribute("disabled", "");
    const here = onThisPage();
    try {
      const p = await getProvider();
      if (!p) throw new Error("Sapient wallet not found. Install it, or claim with lockbox-cli.");
      await requireWalletNetwork(p, net);
      const account = await connect(p);
      await settleEarlier(p, net, (t) => (status.textContent = t));
      if ((await walletKey(p, net)) !== l.reading.state!.beneficiary) {
        throw new Error("The connected wallet is not this lock's beneficiary.");
      }
      const ix = claimInstructions(net, account, l.id);
      status.textContent = "Checking with a dry run…";
      await dryRun(p, ix);
      await submit(p, net, ix, (t) => (status.textContent = t), here);
      status.textContent = "Claimed. Reloading…";
      setTimeout(() => here() && location.reload(), 1500);
    } catch (e) {
      showTxError(net, status, e);
      btn.removeAttribute("disabled");
    }
  });
  return box;
}
