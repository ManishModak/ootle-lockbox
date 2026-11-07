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
import type { Instruction } from "@tari-project/ootle";
import type { NetConfig } from "./config";
import { isValidPublicKey, MAX_FEE, NETWORK_BYTE, parseBeneficiary } from "./newlock";

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

export async function walletNetwork(p: TariProvider): Promise<string> {
  return String(await p.request({ method: "tari_getNetwork" }));
}

/**
 * The connected account's public key, from the wallet's own address (never from the indexer,
 * which this page doesn't control). Null if the address isn't a valid one for `net`.
 */
export async function walletKey(p: TariProvider, net: NetConfig): Promise<string | null> {
  const address = await p.request({ method: "tari_getWalletAddress" });
  return typeof address === "string" ? parseBeneficiary(address, NETWORK_BYTE[net.name]) : null;
}

export async function balances(p: TariProvider): Promise<Balance[]> {
  const list = (await p.request({ method: "tari_getBalances" })) as Balance[];
  return list.filter((b) => BigInt(b.amount || "0") > 0n && b.kind !== "NonFungible");
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

/** lock.claim() -> deposit into the connected account, in one transaction. */
export function claimInstructions(net: NetConfig, account: string, lock: string): Instruction[] {
  return TransactionBuilder.new(net.network, 0)
    .callMethod({ componentAddress: lock, methodName: "claim" }, [])
    .saveVar("claimed")
    .callMethod({ componentAddress: account, methodName: "deposit" }, [{ Workspace: "claimed" }])
    .buildUnsignedTransaction().instructions as Instruction[];
}

/**
 * The engine's verdict inside an execution result: "accepted", the rejection reason, or null when
 * the shape isn't one we know. `finalize.result` is `{Accept}`, `{Reject}` or `{AcceptFeeRejectRest}`
 * (the fee is taken, nothing else happens).
 */
export function engineVerdict(result: unknown): "accepted" | { rejected: string } | null {
  const r = result as any;
  const outcome = (r?.finalize ?? r?.result?.finalize)?.result;
  if (typeof outcome !== "object" || outcome === null) return null;
  if ("Accept" in outcome) return "accepted";
  const reason = "Reject" in outcome ? outcome.Reject : "AcceptFeeRejectRest" in outcome ? outcome.AcceptFeeRejectRest?.[1] : undefined;
  if (reason === undefined) return null;
  return { rejected: typeof reason === "string" ? reason : JSON.stringify(reason).slice(0, 300) };
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
 *  - the request id is saved before anything can execute and cleared only on a final status
 *    (submitted, rejected, failed) or when the user deliberately forgets it;
 *  - a saved request is followed to its outcome (submitted if approved) before any new one, and
 *    the click that settles it never starts a new transaction;
 *  - every wallet call has a deadline; a timeout keeps the id and reports an unknown outcome.
 */

/** A transaction can't start yet. `canForget`: the user may check their wallet and forget the earlier one. */
export class TxBlocked extends Error {
  constructor(message: string, readonly canForget: boolean) {
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

const UNKNOWN =
  "The outcome of an earlier Lockbox transaction from this browser is unknown. Check your wallet's history: if it went through, don't repeat it.";

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

function savedRequest(net: NetConfig): string | null {
  return localStorage.getItem(pendingKey(net));
}

/** Clears the saved id only if it is still `requestId` (never another request's record). */
function clearSaved(net: NetConfig, requestId: string) {
  if (localStorage.getItem(pendingKey(net)) === requestId) localStorage.removeItem(pendingKey(net));
}

/** For the "I've checked my wallet" action after a TxBlocked with canForget. */
export function forgetEarlierTransaction(net: NetConfig) {
  localStorage.removeItem(pendingKey(net));
}

type Outcome = { status: "submitted"; result: unknown } | { status: "rejected" | "failed"; error: string };

/**
 * Follows one request to a final outcome, submitting it once approved (the wallet runs at most one
 * submit per request, so re-submitting after a lost response is safe). Throws TxBlocked, with the
 * id still saved, when the wallet stops answering or the request stays stuck.
 */
async function follow(p: TariProvider, requestId: string, onStatus: (s: string) => void): Promise<Outcome> {
  let pollFailures = 0; // consecutive: reset by any answer
  let submitFailures = 0;
  let stuckSince: number | null = null;
  for (;;) {
    let r: any;
    try {
      r = await rpc(p, "tari_getTransactionRequest", { requestId });
    } catch {
      if (++pollFailures >= MAX_FAILURES) throw new TxBlocked(`Lost contact with your wallet. ${UNKNOWN}`, true);
      await sleep(1500);
      continue;
    }
    pollFailures = 0;
    if (r.status === "submitted") return { status: "submitted", result: r.result };
    if (r.status === "rejected" || r.status === "failed") return { status: r.status, error: r.error ?? `Transaction ${r.status}.` };
    if (r.status === "pending") {
      stuckSince = null;
      // Sapient never runs a request whose approval window expired.
      if (typeof r.expiresAt === "number" && Date.now() > r.expiresAt) return { status: "failed", error: "The request expired in your wallet." };
      onStatus("Waiting for approval in your wallet...");
      await sleep(800);
      continue;
    }
    stuckSince ??= Date.now();
    if (Date.now() - stuckSince > STUCK_LIMIT_MS) throw new TxBlocked(`Your wallet has been submitting for a long time. ${UNKNOWN}`, true);
    onStatus("Submitting...");
    if (r.status === "approved") {
      try {
        return { status: "submitted", result: await rpc(p, "tari_submitTransactionRequest", { requestId }, SUBMIT_TIMEOUT_MS) };
      } catch {
        // Failed (the next poll says so) or the response was lost (the next poll shows progress).
        if (++submitFailures >= MAX_FAILURES) throw new TxBlocked(`Lost contact with your wallet while submitting. ${UNKNOWN}`, true);
      }
    }
    await sleep(1500);
  }
}

/** The engine's rejection inside a submitted result, as an error message, or null. */
function rejectionText(result: unknown): string | null {
  const v = engineVerdict(result);
  return v !== null && v !== "accepted" ? v.rejected : null;
}

/**
 * Settles the request saved by an earlier attempt. Returns normally only when nothing from it can
 * still execute and nothing executed; otherwise throws, so the user sees the outcome first.
 */
async function settleSaved(p: TariProvider, net: NetConfig, onStatus: (s: string) => void) {
  const id = savedRequest(net);
  if (!id) return;
  onStatus("Checking an earlier transaction from this browser...");
  const out = await follow(p, id, onStatus);
  clearSaved(net, id);
  if (out.status !== "submitted") return; // never executed: safe to go on
  const rejected = rejectionText(out.result);
  throw new TxBlocked(
    rejected
      ? `An earlier Lockbox transaction from this browser was rejected by the network (${rejected}). Press again to continue.`
      : "An earlier Lockbox transaction from this browser went through. Check your locks and wallet history before doing this again; press again to continue.",
    false,
  );
}

/** Runs `fn` only if no other tab or call is running a transaction on `net`. */
async function exclusive<T>(net: NetConfig, fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("This browser can't track transactions safely. Use lockbox-cli instead.");
  return navigator.locks.request(`lockbox-tx-${net.name}`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new TxBlocked("Another Lockbox tab or action is running a transaction. Finish it there first.", false);
    return fn();
  });
}

/**
 * Opens the wallet's approval popup for `instructions` and submits once approved. Returns the
 * operation's result. Throws TxBlocked while an earlier transaction is unsettled.
 */
export async function submit(
  p: TariProvider,
  net: NetConfig,
  instructions: Instruction[],
  onStatus: (s: string) => void,
): Promise<unknown> {
  return exclusive(net, async () => {
    await settleSaved(p, net, onStatus);
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
    clearSaved(net, requestId);
    if (out.status !== "submitted") throw new Error(out.error);
    const rejected = rejectionText(out.result);
    if (rejected) throw new Error(`The network rejected the transaction: ${rejected}`);
    return out.result;
  });
}
