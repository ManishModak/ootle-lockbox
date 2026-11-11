/**
 * Create a lock with the Sapient wallet: pick a token, amount, unlock time and beneficiary, review
 * the token's rules, dry-run, then sign. Ends on the new lock's proof page.
 */
import { MAX_MEMO_BYTES, REPO_URL, type NetConfig } from "../config";
import { addressFromTxEvent, currentEpoch, getSubstate } from "../indexer";
import { lockableAmount, MAX_FEE, NATIVE_TARI, NETWORK_BYTE, parseBeneficiary, unlockEpochFor } from "../newlock";
import { errorText, flowSteps, h, link, notice, onThisPage } from "../ui";
import { formatAmount, parseAmount, readResource } from "../verify";
import { balances, connect, dryRun, getProvider, lockInstructions, settleEarlier, submit, txHash, walletKey, requireWalletNetwork, type Balance } from "../wallet";
import { checkList, setFormBusy, showTxError } from "./lock";
import { notPublishedNotice } from "./home";
import { unlockPicker, unlockTerms } from "./unlockpicker";

export async function createView(net: NetConfig, root: HTMLElement) {
  root.append(h("p", { class: "crumb" }, link(net, "", "Lockbox"), " / create"), h("h1", {}, "Create a lock"));
  if (!net.lockboxTemplate) {
    root.append(notPublishedNotice(net, "Lockbox", "create"));
    return;
  }
  const status = h("p", { class: "muted", "aria-live": "polite" });
  const btn = h("button", { type: "button" }, "Connect Sapient wallet");
  const intro = h(
    "section",
    { class: "card intro" },
    h("p", {}, `You need the Sapient wallet extension on ${net.label}. The tokens you lock must be a public balance in it.`),
    btn,
    status,
    h("p", { class: "muted small" }, "No wallet? Lock from a terminal with ", h("a", { href: REPO_URL }, "lockbox-cli"), "."),
  );
  const flow = h(
    "div",
    { class: "flow" },
    intro,
    flowSteps(
      "Connect your Sapient wallet.",
      "Pick a token, amount, unlock time and beneficiary.",
      "Review the token's rules and the lock's terms.",
      "Sign. A dry run checks it first.",
    ),
  );
  root.append(flow);
  btn.addEventListener("click", async () => {
    btn.setAttribute("disabled", "");
    status.textContent = "Connecting…";
    try {
      const p = await getProvider();
      if (!p) throw new Error("Sapient wallet not found in this browser.");
      await requireWalletNetwork(p, net);
      const account = await connect(p);
      // An earlier lock whose outcome is unknown is settled first, even if it spent the balance this form needs.
      await settleEarlier(p, net, (t) => (status.textContent = t));
      const [list, acct, epoch, myKey] = await Promise.all([balances(p), getSubstate(net, account), currentEpoch(net), walletKey(p, net)]);
      // "Me" is the wallet's own key. The indexer's view of the account must agree, which also
      // confirms this key is the one that signs for the account (and so can claim).
      const owner = String((acct.value as any)?.Component?.header?.owner_rule?.ByPublicKey ?? "").toLowerCase();
      if (!myKey) throw new Error(`Could not read your wallet's ${net.label} address.`);
      if (owner !== myKey) throw new Error("Your wallet's key doesn't match its account's owner on the indexer, so this page can't confirm who you are. Lock with lockbox-cli instead.");
      // The form and its review take the full width; the steps have done their job.
      flow.replaceWith(form(net, p, account, myKey, list, epoch));
    } catch (e) {
      showTxError(net, status, e);
      btn.removeAttribute("disabled");
    }
  });
}

type Provider = NonNullable<Awaited<ReturnType<typeof getProvider>>>;

function form(net: NetConfig, p: Provider, account: string, myKey: string, list: Balance[], epoch: number): HTMLElement {
  if (list.length === 0) {
    return notice("warn", "This account has no public token balance to lock. Private TARI must be made public (unshielded) in Sapient first.");
  }
  const label = (b: Balance) => `${b.symbol ?? b.name ?? b.resourceAddress.slice(0, 18)} · ${formatAmount(BigInt(b.amount), b.divisibility)} available`;
  const token = h("select", { id: "token" }, ...list.map((b, i) => h("option", { value: String(i) }, label(b)))) as HTMLSelectElement;
  const amount = h("input", { id: "amount", type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "0.0" }) as HTMLInputElement;
  const max = h("button", { type: "button", class: "ghost small" }, "Max");
  const when = unlockPicker(net, epoch, "when");
  const meRadio = h("input", { type: "radio", name: "ben", value: "me", checked: true }) as HTMLInputElement;
  const otherRadio = h("input", { type: "radio", name: "ben", value: "other" }) as HTMLInputElement;
  const other = h("input", { id: "other", type: "text", placeholder: "otl_… or 64-hex public key", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  // Asked for only when "Someone else" is chosen; "Me" never reads it.
  const otherField = h("div", { hidden: true }, h("label", { for: "other" }, "Their Ootle address or public key"), other);
  const showOther = () => (otherField.hidden = !otherRadio.checked);
  meRadio.addEventListener("change", showOther);
  otherRadio.addEventListener("change", showOther);
  const memo = h("input", { id: "memo", type: "text", maxlength: String(MAX_MEMO_BYTES), placeholder: "e.g. Team allocation, 12-month cliff" }) as HTMLInputElement;
  const errors = h("p", { class: "error", "aria-live": "polite" });
  const review = h("div");

  const chosen = () => list[Number(token.value)];
  const lockable = (b: Balance) => lockableAmount(b.resourceAddress, BigInt(b.amount));
  max.addEventListener("click", () => (amount.value = formatAmount(lockable(chosen()), chosen().divisibility).replace(/,/g, "")));

  // The picker's line is a preview only: the epoch is fetched again at review and again before signing.
  const target = () => when.target();

  const beneficiary = (): string | null => (meRadio.checked ? myKey : parseBeneficiary(other.value, NETWORK_BYTE[net.name]));

  const go = h("button", { type: "submit" }, "Review");
  const f = h(
    "form",
    { class: "card form" },
    h("label", { for: "token" }, "Token"),
    token,
    h("label", { for: "amount" }, "Amount"),
    h("div", { class: "row" }, amount, max),
    when.el,
    h(
      "fieldset",
      {},
      h("legend", {}, "Beneficiary (who can claim)"),
      h("label", { class: "inline" }, meRadio, " Me (this wallet)"),
      h("label", { class: "inline" }, otherRadio, " Someone else"),
      otherField,
    ),
    h("label", { for: "memo" }, "Memo (public, optional)"),
    memo,
    errors,
    go,
  );
  // Only the newest review may show or sign; a review in flight blocks the form (see reviewBox).
  let reviewSeq = 0;
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const seq = ++reviewSeq;
    errors.textContent = "";
    review.replaceChildren();
    const b = chosen();
    const amt = parseAmount(amount.value, b.divisibility);
    const t = target();
    let now: number;
    try {
      now = await currentEpoch(net);
    } catch (err) {
      errors.textContent = errorText(err);
      return;
    }
    const ue = unlockEpochFor(net, now, t, Date.now());
    const ben = beneficiary();
    const memoBytes = new TextEncoder().encode(memo.value).length;
    const problem =
      amt === null || amt <= 0n
        ? `Enter an amount with at most ${b.divisibility} decimals.`
        : amt > lockable(b)
          ? b.resourceAddress === NATIVE_TARI
            ? `That leaves too little for the fee. You can lock up to ${formatAmount(lockable(b), b.divisibility)}.`
            : "That is more than your public balance."
          : ue === null
            ? "Pick an unlock time in the future."
            : ben === null
              ? `Enter a valid ${net.label} Ootle address or public key (64 hex characters).`
              : memoBytes > MAX_MEMO_BYTES
                ? `The memo is ${memoBytes} bytes; the limit is ${MAX_MEMO_BYTES}.`
                : null;
    if (problem) {
      errors.textContent = problem;
      return;
    }
    const box = await reviewBox(net, p, account, b, amt!, t, ue!, ben!, memo.value, ben === myKey, now, f);
    if (seq === reviewSeq) review.append(box);
  });
  return h("div", {}, f, review);
}

async function reviewBox(
  net: NetConfig,
  p: Provider,
  account: string,
  b: Balance,
  amount: bigint,
  target: number,
  unlockEpoch: number,
  beneficiary: string,
  memo: string,
  isMe: boolean,
  epoch: number,
  form: HTMLElement,
): Promise<HTMLElement> {
  const box = h("section", { class: "card review" }, h("h2", {}, "Review"));
  // Issuer powers and rules that couldn't be read both stop Verified, but are worded apart.
  let risks: string[] = [];
  let unread: string[] = [];
  try {
    const r = readResource((await getSubstate(net, b.resourceAddress)).value);
    if (r) [risks, unread] = [r.lockRisks, r.unreadable];
    else unread = ["The token's rules could not be read."];
  } catch (e) {
    unread = [`The token's rules could not be read: ${errorText(e)}`];
  }
  const sym = b.symbol ?? "tokens";
  box.append(
    h(
      "dl",
      { class: "facts" },
      h("dt", {}, "Lock"),
      h("dd", { class: "big" }, `${formatAmount(amount, b.divisibility)} ${sym}`),
      h("dt", {}, "Until"),
      h("dd", {}, ...unlockTerms(net, unlockEpoch, epoch, target)),
      h("dt", {}, "Network fee"),
      h("dd", {}, `up to ${formatAmount(MAX_FEE, 6)} TARI`),
      h("dt", {}, "Beneficiary"),
      h("dd", {}, h("code", { class: "wrap" }, beneficiary), isMe ? " (you)" : ""),
      memo ? h("dt", {}, "Memo") : null,
      memo ? h("dd", { class: "memo" }, memo) : null,
    ),
    risks.length
      ? h(
          "div",
          {},
          notice("warn", h("strong", {}, "This lock won't be marked verified. "), "The token's issuer could still undo it:"),
          checkList(risks.map((x) => ({ ok: false, label: x }))),
          unread.length ? checkList(unread.map((x) => ({ ok: false, unknown: true, label: x }))) : null,
        )
      : unread.length
        ? h(
            "div",
            {},
            notice("warn", h("strong", {}, "This lock won't be marked verified yet. "), "Part of the token's rules couldn't be read, so its proof page can't verify it until they can:"),
            checkList(unread.map((x) => ({ ok: false, unknown: true, label: x }))),
          )
        : notice("ok", "This token's issuer can't undo the lock, so its proof page will show Verified."),
    notice("bad", h("strong", {}, "This can't be undone. "), "Nobody can release the tokens before the unlock epoch, and only the beneficiary key above can claim them. Check the key carefully."),
  );
  const status = h("p", { class: "muted", "aria-live": "polite" });
  const sign = h("button", { type: "button" }, "Lock tokens");
  sign.addEventListener("click", async () => {
    sign.setAttribute("disabled", "");
    setFormBusy(form, true);
    const here = onThisPage();
    try {
      await settleEarlier(p, net, (t) => (status.textContent = t));
      // Time has passed since review: the reviewed epoch must still cover the chosen time.
      const needed = unlockEpochFor(net, await currentEpoch(net), target, Date.now());
      if (needed === null || needed > unlockEpoch) throw new Error("Time has moved on since you reviewed. Press Review again.");
      const ix = lockInstructions(net, account, b.resourceAddress, amount, unlockEpoch, beneficiary, memo);
      status.textContent = "Checking with a dry run…";
      await dryRun(p, ix);
      const result = await submit(p, net, ix, (t) => (status.textContent = t), here);
      status.textContent = "Locked. Finding your lock…";
      const lock = await findNewLock(net, result);
      if (lock && here()) location.hash = `#/${net.name}/lock/${lock}`;
      else status.textContent = "Locked. Your lock will appear under Recent locks shortly.";
    } catch (e) {
      showTxError(net, status, e);
      setFormBusy(form, false);
      sign.removeAttribute("disabled");
    }
  });
  box.append(h("div", { class: "row" }, sign), status);
  return box;
}

/**
 * The lock this transaction made, from the LockCreated event the pinned template emitted in it.
 * Addresses elsewhere in the result can come from the user's own text (the memo), so they are
 * never used. Null when the result has no hash or the indexer doesn't show the event yet.
 */
async function findNewLock(net: NetConfig, result: unknown): Promise<string | null> {
  const tx = txHash(result);
  if (!tx || !net.lockboxTemplate) return null;
  try {
    return await addressFromTxEvent(net, net.lockboxTemplate, "Lockbox.LockCreated", tx, "lock", "component");
  } catch {
    return null; // the indexer failed; the lock still shows under Recent locks
  }
}
