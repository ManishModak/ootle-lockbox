/**
 * Launch a token with the Sapient wallet (`#/<network>/launch`): name it, set its supply, declare
 * the allocations to lock, review every key and amount, dry-run, then sign. Ends on the new
 * token's launch proof page.
 */
import type { NetConfig } from "../config";
import { currentEpoch, getSubstate } from "../indexer";
import { LAUNCH_DECIMALS, launchProblem, MAX_LAUNCH_LOCKS, type LaunchInput, type LaunchLockInput } from "../newlaunch";
import { MAX_FEE, NATIVE_TARI, NETWORK_BYTE, parseBeneficiary, unlockEpochFor } from "../newlock";
import { errorText, estimatedDate, formatDate, h, link, notice } from "../ui";
import { formatAmount, parseAmount, readResource } from "../verify";
import { balances, connect, dryRun, getProvider, launchInstructions, submit, walletKey, walletNetwork } from "../wallet";
import { showTxError } from "./lock";

const CLI_URL = "https://github.com/ManishModak/ootle-lockbox"; // TODO: the Launch Commitments repo once public

export async function launchFormView(net: NetConfig, root: HTMLElement) {
  root.append(h("p", { class: "crumb" }, link(net, "", "Lockbox"), " / launch"), h("h1", {}, "Launch a token"));
  if (!net.launchTemplate || net.launchFee === null) {
    root.append(notice("info", `Launch Commitments is not published on ${net.label} yet.`));
    return;
  }
  const fee = net.launchFee;
  const status = h("p", { class: "muted", "aria-live": "polite" });
  const btn = h("button", { type: "button" }, "Connect Sapient wallet");
  const intro = h(
    "section",
    { class: "card" },
    h(
      "p",
      {},
      `Creates a fixed-supply token that nobody, you included, can ever mint, burn, freeze or change, and locks the allocations you choose in Lockbox, in one transaction. The flat fee is ${formatAmount(fee, 6)} TARI, paid from your public TARI balance.`,
    ),
    btn,
    status,
    h("p", { class: "muted small" }, "No wallet? Launch from a terminal with launch-cli (", h("a", { href: CLI_URL }, "source"), ")."),
  );
  root.append(intro);
  btn.addEventListener("click", async () => {
    btn.setAttribute("disabled", "");
    status.textContent = "Connecting…";
    try {
      const p = await getProvider();
      if (!p) throw new Error("Sapient wallet not found in this browser.");
      const wn = await walletNetwork(p);
      if (wn !== net.walletNetwork) throw new Error(`Your wallet is on ${wn}. Switch it to ${net.label}, or open this page for ${wn}.`);
      const account = await connect(p);
      const [list, acct, epoch, myKey] = await Promise.all([balances(p), getSubstate(net, account), currentEpoch(net), walletKey(p, net)]);
      const owner = String((acct.value as any)?.Component?.header?.owner_rule?.ByPublicKey ?? "").toLowerCase();
      if (!myKey) throw new Error(`Could not read your wallet's ${net.label} address.`);
      if (owner !== myKey) throw new Error("Your wallet's key doesn't match its account's owner on the indexer, so this page can't confirm who you are. Use launch-cli instead.");
      const tari = BigInt(list.find((b) => b.resourceAddress === NATIVE_TARI)?.amount ?? "0");
      if (tari < fee + MAX_FEE) {
        throw new Error(`You need at least ${formatAmount(fee + MAX_FEE, 6)} TARI as a public balance (the fee plus the network fee); you have ${formatAmount(tari, 6)}.`);
      }
      intro.replaceWith(form(net, p, account, myKey, epoch));
    } catch (e) {
      status.textContent = errorText(e);
      btn.removeAttribute("disabled");
    }
  });
}

type Provider = NonNullable<Awaited<ReturnType<typeof getProvider>>>;

/** One lock row's inputs. */
interface LockRow {
  el: HTMLElement;
  amount: HTMLInputElement;
  when: HTMLInputElement;
  key: HTMLInputElement;
}

function form(net: NetConfig, p: Provider, account: string, myKey: string, epoch: number): HTMLElement {
  const input = (id: string, attrs: Record<string, string> = {}) => h("input", { id, type: "text", autocomplete: "off", ...attrs }) as HTMLInputElement;
  const symbol = input("symbol", { maxlength: "12", placeholder: "e.g. ACME" });
  const name = input("name", { maxlength: "64", placeholder: "e.g. Acme Token" });
  const image = input("image", { placeholder: "https://… (optional)" });
  const supply = input("supply", { inputmode: "decimal", placeholder: "e.g. 1000000" });
  const rows: LockRow[] = [];
  const list = h("div", { class: "locks" });
  const add = h("button", { type: "button", class: "ghost small" }, "Add a lock");
  const errors = h("p", { class: "error", "aria-live": "polite" });
  const review = h("div");

  const addRow = () => {
    const r: LockRow = {
      amount: h("input", { type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "Amount", "aria-label": "Amount" }) as HTMLInputElement,
      when: h("input", { type: "datetime-local", "aria-label": "Unlock after" }) as HTMLInputElement,
      key: h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "Beneficiary: blank = me, or otl_… / 64-hex key", "aria-label": "Beneficiary" }) as HTMLInputElement,
      el: h("fieldset", { class: "lock-row" }),
    };
    const remove = h("button", { type: "button", class: "ghost small" }, "Remove");
    remove.addEventListener("click", () => {
      rows.splice(rows.indexOf(r), 1);
      r.el.remove();
      add.removeAttribute("disabled");
    });
    r.el.append(h("legend", {}, "Lock"), r.amount, r.when, r.key, remove);
    rows.push(r);
    list.append(r.el);
    if (rows.length >= MAX_LAUNCH_LOCKS) add.setAttribute("disabled", "");
  };
  add.addEventListener("click", addRow);
  addRow();

  const f = h(
    "form",
    { class: "card form" },
    h("label", { for: "symbol" }, "Symbol"),
    symbol,
    h("label", { for: "name" }, "Name"),
    name,
    h("label", { for: "image" }, "Image URL"),
    image,
    h("label", { for: "supply" }, `Total supply (${LAUNCH_DECIMALS} decimals)`),
    supply,
    h("h2", {}, "Allocations to lock"),
    h("p", { class: "muted small" }, "Each lock holds its amount until the chosen time; only its beneficiary can then claim it. The rest of the supply comes to your wallet."),
    list,
    add,
    errors,
    h("button", { type: "submit" }, "Review"),
  );

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    errors.textContent = "";
    review.replaceChildren();
    let now: number;
    try {
      now = await currentEpoch(net);
    } catch (err) {
      errors.textContent = errorText(err);
      return;
    }
    const parsed = readForm(net, myKey, now, { symbol, name, image, supply }, rows);
    if (typeof parsed === "string") {
      errors.textContent = parsed;
      return;
    }
    review.append(reviewBox(net, p, account, myKey, parsed.input, parsed.targets, now));
  });
  return h("div", {}, f, review);
}

/** The form as launch input plus each lock's chosen time, or the first problem in plain words. */
function readForm(
  net: NetConfig,
  myKey: string,
  now: number,
  f: { symbol: HTMLInputElement; name: HTMLInputElement; image: HTMLInputElement; supply: HTMLInputElement },
  rows: LockRow[],
): { input: LaunchInput; targets: number[] } | string {
  const supply = parseAmount(f.supply.value, LAUNCH_DECIMALS);
  if (supply === null) return `Enter the supply as a number with at most ${LAUNCH_DECIMALS} decimals.`;
  const locks: LaunchLockInput[] = [];
  const targets: number[] = [];
  for (const [i, r] of rows.entries()) {
    const amount = parseAmount(r.amount.value, LAUNCH_DECIMALS);
    if (amount === null) return `Lock ${i + 1}: enter an amount with at most ${LAUNCH_DECIMALS} decimals.`;
    const target = r.when.value ? Date.parse(r.when.value) : Number.NaN;
    const epoch = unlockEpochFor(net, now, target, Date.now());
    if (epoch === null) return `Lock ${i + 1}: pick an unlock time in the future.`;
    const key = r.key.value.trim() === "" ? myKey : parseBeneficiary(r.key.value, NETWORK_BYTE[net.name]);
    if (key === null) return `Lock ${i + 1}: enter a valid ${net.label} Ootle address or public key (64 hex characters), or leave it blank for yourself.`;
    locks.push({ amount, unlockEpoch: BigInt(epoch), beneficiary: key });
    targets.push(target);
  }
  const input = { symbol: f.symbol.value.trim(), name: f.name.value.trim(), imageUrl: f.image.value.trim(), supply, locks };
  return launchProblem(input, BigInt(now)) ?? { input, targets };
}

function reviewBox(net: NetConfig, p: Provider, account: string, myKey: string, input: LaunchInput, targets: number[], epoch: number): HTMLElement {
  const sym = input.symbol;
  const locked = input.locks.reduce((s, l) => s + l.amount, 0n);
  const box = h("section", { class: "card review" }, h("h2", {}, "Review"));
  box.append(
    h(
      "dl",
      { class: "facts" },
      h("dt", {}, "Token"),
      h("dd", {}, `${input.name} (${sym})`),
      h("dt", {}, "Supply"),
      h("dd", { class: "big" }, `${formatAmount(input.supply, LAUNCH_DECIMALS)} ${sym}`),
      h("dt", {}, "Locked at launch"),
      h("dd", {}, `${formatAmount(locked, LAUNCH_DECIMALS)} ${sym}`),
      h("dt", {}, "To your wallet"),
      h("dd", {}, `${formatAmount(input.supply - locked, LAUNCH_DECIMALS)} ${sym}`),
      h("dt", {}, "Launch fee"),
      h("dd", {}, `${formatAmount(net.launchFee ?? 0n, 6)} TARI, plus a network fee of up to ${formatAmount(MAX_FEE, 6)} TARI`),
    ),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", { class: "num" }, "Amount"), h("th", {}, "Unlocks"), h("th", {}, "Beneficiary (full key)"))),
        h(
          "tbody",
          {},
          ...input.locks.map((l, i) =>
            h(
              "tr",
              {},
              h("td", { class: "num" }, `${formatAmount(l.amount, LAUNCH_DECIMALS)} ${sym}`),
              h("td", {}, `epoch ${l.unlockEpoch}, most likely around ${estimatedDate(net, Number(l.unlockEpoch), epoch)}; after ${formatDate(targets[i])} unless epochs run shorter than ${net.epochMinutes.min} minutes`),
              h("td", {}, h("code", { class: "wrap" }, l.beneficiary), l.beneficiary === myKey ? " (you)" : ""),
            ),
          ),
        ),
      ),
    ),
    notice(
      "bad",
      h("strong", {}, "This can't be undone. "),
      "Nobody, you included, can ever mint more, burn, freeze or change this token. Each lock holds its tokens until its epoch, and only the key shown can claim them: check every key carefully.",
    ),
  );
  const status = h("p", { class: "muted", "aria-live": "polite" });
  const sign = h("button", { type: "button" }, "Launch");
  sign.addEventListener("click", async () => {
    sign.setAttribute("disabled", "");
    try {
      // Time has passed since review: each reviewed epoch must still cover its chosen time.
      const now = await currentEpoch(net);
      input.locks.forEach((l, i) => {
        const needed = unlockEpochFor(net, now, targets[i], Date.now());
        if (needed === null || BigInt(needed) > l.unlockEpoch) throw new Error("Time has moved on since you reviewed. Press Review again.");
      });
      const ix = launchInstructions(net, account, input);
      status.textContent = "Checking with a dry run…";
      await dryRun(p, ix);
      const result = await submit(p, net, ix, (t) => (status.textContent = t));
      status.textContent = "Launched. Finding your token…";
      const token = await findLaunchedToken(net, result);
      if (token) location.hash = `#/${net.name}/launch/${token}`;
      else status.textContent = "Launched. Find the new token in your wallet, then open its page here to see the proof.";
    } catch (e) {
      showTxError(net, status, e);
      sign.removeAttribute("disabled");
    }
  });
  box.append(h("div", { class: "row" }, sign), status);
  return box;
}

/** The wallet's result shape isn't documented, so take any resource in it that names a launch record. */
async function findLaunchedToken(net: NetConfig, result: unknown): Promise<string | null> {
  const text = JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)) ?? "";
  const candidates = [...new Set(text.match(/resource_[0-9a-f]{64}/g) ?? [])].filter((r) => r !== NATIVE_TARI);
  for (const c of candidates) {
    try {
      if (readResource((await getSubstate(net, c)).value)?.launchedBy) return c;
    } catch {
      // not readable yet or not a token
    }
  }
  return null;
}
