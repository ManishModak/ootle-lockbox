/**
 * Sapient wallet bridge (`window.tari`, docs: github.com/chironbuilds/tari-wallet docs/integration).
 * Builds Lockbox transactions with the Ootle SDK and submits them through the wallet's
 * create/approve/submit flow. A lock can't be undone, so a transaction whose outcome is unknown
 * (lost wallet response, reload) must be settled before another is created. See "Transaction
 * tracking" below.
 */
import {
  amountLiteral,
  intLiteral,
  publicKeyLiteral,
  resourceAddressLiteral,
  stringLiteral,
  TransactionBuilder,
} from "@tari-project/ootle";
import type { Instruction, InstructionArg } from "@tari-project/ootle";
import type { NetConfig } from "./config";
import type { LaunchInput } from "./newlaunch";
import { isValidPublicKey, MAX_FEE, NATIVE_TARI, NETWORK_BYTE, parseBeneficiary } from "./newlock";
import { validDivisibility } from "./verify";

interface TariProvider {
  isTariWallet?: boolean;
  request(args: { method: string; params?: unknown }): Promise<any>;
}

declare global {
  interface Window {
    tari?: TariProvider;
  }
}

export interface Balance {
  resourceAddress: string;
  kind: string;
  amount: string; // public (revealed) amount, atomic units
  divisibility: number;
  symbol: string | null;
  name: string | null;
}

/** Waits briefly for the extension to inject itself. */
export async function getProvider(timeoutMs = 1500): Promise<TariProvider | null> {
  if (window.tari?.isTariWallet) return window.tari;
  return new Promise((resolve) => {
    const done = () => resolve(window.tari?.isTariWallet ? window.tari : null);
    window.addEventListener("tari#initialized", done, { once: true });
    setTimeout(done, timeoutMs);
  });
}

export async function connect(p: TariProvider): Promise<string> {
  const [account] = await p.request({ method: "tari_requestAccounts" });
  if (typeof account !== "string") throw new Error("The wallet returned no account.");
  return account;
}

/** Throws a user-facing error unless the wallet is on `net`; used before every signing flow. */
export async function requireWalletNetwork(p: TariProvider, net: NetConfig): Promise<void> {
  const wn = String(await p.request({ method: "tari_getNetwork" }));
  if (wn === net.walletNetwork) return;
  throw new Error(`Your wallet is on ${wn}; this page is for ${net.label}. Switch your wallet to ${net.label} and try again.`);
}

/**
 * The connected account's public key, from the wallet's own address (never from the indexer,
 * which this page doesn't control). Null if the address isn't a valid one for `net`.
 */
export async function walletKey(p: TariProvider, net: NetConfig): Promise<string | null> {
  const address = await p.request({ method: "tari_getWalletAddress" });
  return typeof address === "string" ? parseBeneficiary(address, NETWORK_BYTE[net.name]) : null;
}

/**
 * The wallet's lockable public balances. One without a valid precision is left out: amounts typed
 * for it couldn't be converted safely (1.5 would become 15 units).
 */
export async function balances(p: TariProvider): Promise<Balance[]> {
  const list = (await p.request({ method: "tari_getBalances" })) as Balance[];
  return list.filter((b) => BigInt(b.amount || "0") > 0n && b.kind !== "NonFungible" && validDivisibility(b.divisibility));
}

/** account.withdraw -> Lockbox::lock(tokens, epoch, beneficiary, memo). */
export function lockInstructions(
  net: NetConfig,
  account: string,
  resource: string,
  amount: bigint,
  unlockEpoch: number,
  beneficiaryHex: string,
  memo: string,
): Instruction[] {
  if (!net.lockboxTemplate) throw new Error(`Lockbox is not published on ${net.label} yet.`);
  if (!isValidPublicKey(beneficiaryHex)) throw new Error("The beneficiary key is not a valid public key.");
  return TransactionBuilder.new(net.network, 0)
    .callMethod({ componentAddress: account, methodName: "withdraw" }, [resourceAddressLiteral(resource), amountLiteral(amount)])
    .saveVar("tokens")
    .callFunction({ templateAddress: `template_${net.lockboxTemplate}`, functionName: "lock" }, [
      { Workspace: "tokens" },
      intLiteral(BigInt(unlockEpoch)),
      publicKeyLiteral(beneficiaryHex),
      stringLiteral(memo),
    ])
    .buildUnsignedTransaction().instructions as Instruction[];
}

/**
 * The template's `locks: Vec<(Amount, u64, RistrettoPublicKeyBytes)>` argument: a CBOR array of
 * 3-item arrays, built from the SDK's encodings of each item.
 */
export function locksLiteral(locks: LaunchInput["locks"]): InstructionArg {
  if (locks.length > 23) throw new Error("Too many locks."); // one-byte CBOR array header
  const hex = (a: InstructionArg) => (a as { Literal: string }).Literal;
  const items = locks.map((l) => "83" + hex(amountLiteral(l.amount)) + hex(intLiteral(l.unlockEpoch)) + hex(publicKeyLiteral(l.beneficiary)));
  return { Literal: (0x80 + locks.length).toString(16) + items.join("") };
}

/**
 * account.withdraw(fee in TARI) -> LaunchRecord::launch(...) -> account.deposit(remainder), all in
 * the main instructions, so any failure undoes the whole launch, fee included.
 */
export function launchInstructions(net: NetConfig, account: string, input: LaunchInput): Instruction[] {
  if (!net.launchTemplate || net.launchFee === null) throw new Error(`Launch Commitments is not published on ${net.label} yet.`);
  if (!input.locks.every((l) => isValidPublicKey(l.beneficiary))) throw new Error("A beneficiary key is not a valid public key.");
  return TransactionBuilder.new(net.network, 0)
    .callMethod({ componentAddress: account, methodName: "withdraw" }, [resourceAddressLiteral(NATIVE_TARI), amountLiteral(net.launchFee)])
    .saveVar("fee")
    .callFunction({ templateAddress: `template_${net.launchTemplate}`, functionName: "launch" }, [
      { Workspace: "fee" },
      stringLiteral(input.symbol),
      stringLiteral(input.name),
      stringLiteral(input.imageUrl),
      amountLiteral(input.supply),
      locksLiteral(input.locks),
    ])
    .saveVar("rest")
    .callMethod({ componentAddress: account, methodName: "deposit" }, [{ Workspace: "rest" }])
    .buildUnsignedTransaction().instructions as Instruction[];
}

/** lock.claim() -> deposit into the connected account, in one transaction. */
export function claimInstructions(net: NetConfig, account: string, lock: string): Instruction[] {
  return TransactionBuilder.new(net.network, 0)
    .callMethod({ componentAddress: lock, methodName: "claim" }, [])
    .saveVar("claimed")
    .callMethod({ componentAddress: account, methodName: "deposit" }, [{ Workspace: "claimed" }])
    .buildUnsignedTransaction().instructions as Instruction[];
}

/*
 * What Sapient returns. A dry run: `{transaction_id, result: ExecuteResult}`. A submit: a receipt
 * `{transaction_id, result: "Pending" | {Rejected} | {Finalized: {final_decision, abort_details,
 * execution_result: ExecuteResult}}}` (checked against a real Esmeralda receipt, Sapient 0.9.3).
 * An ExecuteResult's `finalize` holds the engine's `result` and the `transaction_hash`.
 */
const reasonText = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x ?? null).slice(0, 300));

/**
 * The network's verdict on a wallet result: "accepted", the rejection reason, or null when it
 * isn't known (still pending, or a shape we don't recognise). The engine's `finalize.result` is
 * `{Accept}`, `{Reject}` or `{AcceptFeeRejectRest}` (the fee is taken, nothing else happens); a
 * submitted transaction must also have been committed.
 */
export function engineVerdict(result: unknown): "accepted" | { rejected: string } | null {
  const r = (result as any)?.result;
  if (typeof r !== "object" || r === null) return null;
  if ("Rejected" in r) return { rejected: reasonText(r.Rejected) };
  let executed = r;
  if ("Finalized" in r) {
    const decision = r.Finalized?.final_decision;
    if (decision === undefined) return null;
    if (decision !== "Commit") return { rejected: `not committed: ${reasonText(r.Finalized.abort_details ?? decision)}` };
    executed = r.Finalized.execution_result;
  }
  const outcome = executed?.finalize?.result;
  if (typeof outcome !== "object" || outcome === null) return null;
  if ("Accept" in outcome) return "accepted";
  const reason = "Reject" in outcome ? outcome.Reject : "AcceptFeeRejectRest" in outcome ? outcome.AcceptFeeRejectRest?.[1] : undefined;
  return reason === undefined ? null : { rejected: reasonText(reason) };
}

/** The transaction hash in a submitted receipt (its execution result's `finalize.transaction_hash`), or null. */
export function txHash(result: unknown): string | null {
  const hash = (result as any)?.result?.Finalized?.execution_result?.finalize?.transaction_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : null;
}

/**
 * Runs the transaction without submitting; no approval popup. Throws unless the engine accepted
 * it. Uses the same fee cap as `submit`, so a dry run that passes means the real one can pay.
 */
export async function dryRun(p: TariProvider, instructions: Instruction[]): Promise<void> {
  const result = await p.request({ method: "tari_signAndSubmitTransaction", params: { instructions, dryRun: true, maxFee: MAX_FEE.toString() } });
  const v = engineVerdict(result);
  if (v === "accepted") return;
  throw new Error(v ? `The network would reject this: ${v.rejected}` : "The dry run returned a result this page doesn't recognise, so it stopped.");
}

/*
 * Transaction tracking. A lock can't be undone, so the page must never start a second lock while
 * an earlier one might still execute. Rules:
 *  - one transaction at a time per network, across tabs (Web Locks);
 *  - the request id is saved before anything can execute and cleared only when it is known how it
 *    ended (submitted; rejected by the user; expired unapproved) or when the user deliberately
 *    forgets that exact request. A wallet "failed" is not proof: the wallet may have broadcast
 *    the transaction before failing to read its result;
 *  - a saved request is followed to its outcome (submitted if approved) before any new one, and
 *    the click that settles it never starts a new transaction;
 *  - every wallet call has a deadline; a timeout keeps the id and reports an unknown outcome.
 */

/**
 * A transaction can't start yet. With `forgettable` set, the user may check their wallet history
 * and then forget exactly that request (`forgetEarlierTransaction`).
 */
export class TxBlocked extends Error {
  constructor(message: string, readonly forgettable: string | null = null) {
    super(message);
  }
}

const RPC_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 180_000;
/** How long a request may sit approved or submitting before the page gives up and asks the user. */
const STUCK_LIMIT_MS = 10 * 60_000;
const MAX_FAILURES = 5;

const pendingKey = (net: NetConfig) => `lockbox.pending.${net.name}`;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const UNKNOWN = "Its outcome is unknown. Check your wallet's history: if it went through, don't repeat it.";

/** A wallet call that fails instead of hanging. */
function rpc(p: TariProvider, method: string, params: unknown, ms = RPC_TIMEOUT_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), ms);
    p.request({ method, params }).then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Whether this browser has a transaction on `net` whose outcome it hasn't confirmed yet. */
export function hasSavedRequest(net: NetConfig): boolean {
  try {
    return savedRequest(net) !== null;
  } catch {
    return false;
  }
}

function savedRequest(net: NetConfig): string | null {
  return localStorage.getItem(pendingKey(net));
}

/** Clears the saved id only if it is still `requestId` (never another request's record). */
function clearSaved(net: NetConfig, requestId: string) {
  if (localStorage.getItem(pendingKey(net)) === requestId) localStorage.removeItem(pendingKey(net));
}

/**
 * Follows a transaction saved by an earlier page load to its outcome, under the transaction lock,
 * before anything new is prepared. Throws `TxBlocked` (possibly forgettable) when the user must
 * look first; pressing again then continues. Flows call it before their own checks and dry run,
 * so a spent balance or a failing dry run can never hide an earlier transaction.
 */
export async function settleEarlier(p: TariProvider, net: NetConfig, onStatus: (s: string) => void): Promise<Settled> {
  return exclusive(net, () => settleSaved(p, net, onStatus));
}

/**
 * The "I've checked my wallet" action: forgets `requestId` if it is still the saved one. Runs
 * under the transaction lock, so it can't touch a transaction another tab is running.
 */
export async function forgetEarlierTransaction(net: NetConfig, requestId: string): Promise<void> {
  await exclusive(net, async () => clearSaved(net, requestId));
}

/** How a request ended. `unknown`: the wallet reported a failure, which may be after broadcast. */
type Outcome =
  | { status: "submitted"; result: unknown }
  | { status: "not-run"; error: string }
  | { status: "unknown"; error: string };

/**
 * Follows one request to a final outcome, submitting it once approved (the wallet runs at most one
 * submit per request, so re-submitting after a lost response is safe). Throws TxBlocked, with the
 * id still saved, when the wallet stops answering or the request stays stuck.
 */
async function follow(p: TariProvider, requestId: string, onStatus: (s: string) => void): Promise<Outcome> {
  const blocked = (why: string) => new TxBlocked(`${why} ${UNKNOWN}`, requestId);
  let pollFailures = 0; // consecutive: reset by any answer
  let submitFailures = 0;
  let stuckSince: number | null = null;
  for (;;) {
    let r: any;
    try {
      r = await rpc(p, "tari_getTransactionRequest", { requestId });
    } catch {
      if (++pollFailures >= MAX_FAILURES) throw blocked("Lost contact with your wallet.");
      await sleep(1500);
      continue;
    }
    pollFailures = 0;
    if (r.status === "submitted") return { status: "submitted", result: r.result };
    if (r.status === "rejected") return { status: "not-run", error: r.error ?? "You rejected the transaction." };
    if (r.status === "failed") return { status: "unknown", error: r.error ?? "The wallet reported a failure." };
    if (r.status === "pending") {
      stuckSince = null;
      // Sapient never runs a request whose approval window expired.
      if (typeof r.expiresAt === "number" && Date.now() > r.expiresAt) return { status: "not-run", error: "The request expired in your wallet." };
      onStatus("Waiting for approval in your wallet...");
      await sleep(800);
      continue;
    }
    stuckSince ??= Date.now();
    if (Date.now() - stuckSince > STUCK_LIMIT_MS) throw blocked("Your wallet has been submitting for a long time.");
    onStatus("Submitting...");
    if (r.status === "approved") {
      try {
        return { status: "submitted", result: await rpc(p, "tari_submitTransactionRequest", { requestId }, SUBMIT_TIMEOUT_MS) };
      } catch {
        // Failed (the next poll says so) or the response was lost (the next poll shows progress).
        if (++submitFailures >= MAX_FAILURES) throw blocked("Lost contact with your wallet while submitting.");
      }
    }
    await sleep(1500);
  }
}

/** How settling ended without a throw: nothing was saved, or the saved request never ran. */
export type Settled = "nothing-saved" | "not-run";

/**
 * Settles the request saved by an earlier attempt. Returns normally only when nothing from it can
 * still execute and nothing executed; otherwise throws, so the user sees the outcome first.
 * "nothing-saved" says nothing about a request another tab already settled.
 */
async function settleSaved(p: TariProvider, net: NetConfig, onStatus: (s: string) => void): Promise<Settled> {
  const id = savedRequest(net);
  if (!id) return "nothing-saved";
  onStatus("Checking an earlier transaction from this browser...");
  const out = await follow(p, id, onStatus);
  if (out.status === "unknown") throw new TxBlocked(`An earlier Lockbox transaction failed in your wallet (${out.error}). ${UNKNOWN}`, id);
  if (out.status === "not-run") {
    clearSaved(net, id);
    return "not-run"; // never executed: safe to go on
  }
  const v = engineVerdict(out.result);
  if (v === null) throw new TxBlocked(`An earlier Lockbox transaction from this browser was sent, but your wallet didn't say how it ended. ${UNKNOWN}`, id);
  clearSaved(net, id);
  throw new TxBlocked(
    v === "accepted"
      ? "An earlier Lockbox transaction from this browser went through. Check your locks and wallet history before doing this again; press again to continue."
      : `An earlier Lockbox transaction from this browser was rejected by the network (${v.rejected}). Press again to continue.`,
  );
}

/** Runs `fn` only if no other tab or call is running a transaction on `net`. */
async function exclusive<T>(net: NetConfig, fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("This browser can't track transactions safely. Use lockbox-cli instead.");
  return navigator.locks.request(`lockbox-tx-${net.name}`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new TxBlocked("Another Lockbox tab or action is running a transaction. Finish it there first.");
    return fn();
  });
}

/**
 * Opens the wallet's approval popup for `instructions` and submits once approved. Returns the
 * receipt only when the network accepted and committed it; throws when it was rejected or its
 * outcome isn't known. Throws TxBlocked while an earlier transaction is unsettled. Sends nothing
 * once `stillHere()` is false (the user left the page that asked); a request already sent is
 * still followed to its outcome.
 */
export async function submit(
  p: TariProvider,
  net: NetConfig,
  instructions: Instruction[],
  onStatus: (s: string) => void,
  stillHere: () => boolean,
): Promise<unknown> {
  return exclusive(net, async () => {
    await settleSaved(p, net, onStatus);
    if (!stillHere()) throw new Error("You left the page, so nothing was sent.");
    // Saving must work before anything can execute; a throw here stops the transaction.
    localStorage.setItem(pendingKey(net), "probe");
    localStorage.removeItem(pendingKey(net));
    const { requestId } = await rpc(p, "tari_createTransactionRequest", {
      kind: "instructions",
      instructions,
      maxFee: MAX_FEE.toString(),
    });
    // A reload before this line leaves an approval popup nobody will submit, so it can't execute.
    localStorage.setItem(pendingKey(net), requestId);
    const out = await follow(p, requestId, onStatus);
    if (out.status === "unknown") throw new TxBlocked(`Your wallet reported a failure (${out.error}), possibly after sending the transaction. ${UNKNOWN}`, requestId);
    if (out.status === "not-run") {
      clearSaved(net, requestId);
      throw new Error(out.error);
    }
    const v = engineVerdict(out.result);
    // Tracking clears only on a definite outcome; an unreadable one stays saved and blocks repeats.
    if (v === null) throw new TxBlocked(`Your wallet sent the transaction but didn't say how it ended. ${UNKNOWN}`, requestId);
    clearSaved(net, requestId);
    if (v !== "accepted") throw new Error(`The network rejected the transaction: ${v.rejected}`);
    return out.result;
  });
}
