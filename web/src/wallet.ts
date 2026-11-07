/**
 * Sapient wallet bridge (`window.tari`, docs: github.com/chironbuilds/tari-wallet docs/integration).
 * Builds Lockbox transactions with the Ootle SDK and submits them through the wallet's
 * create/approve/submit flow. A lock can't be undone, so a transaction whose outcome is unknown
 * (lost wallet response, reload) must be settled before another is created: the request id is
 * kept per network until the wallet reports a final status.
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

const pendingKey = (net: NetConfig) => `lockbox.pending.${net.name}`;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const FINAL = new Set(["submitted", "rejected", "failed"]);

function savePending(net: NetConfig, requestId: string | null) {
  try {
    if (requestId) localStorage.setItem(pendingKey(net), requestId);
    else localStorage.removeItem(pendingKey(net));
  } catch {
    // No storage (private mode): a reload can't be reconciled, but a live page still is.
  }
}

function loadPending(net: NetConfig): string | null {
  try {
    return localStorage.getItem(pendingKey(net));
  } catch {
    return null;
  }
}

/**
 * Before a new transaction: make sure the last one this browser started on `net` has a final
 * outcome. Throws while it is still open; if the wallet no longer knows it, forgets it and throws
 * once, so the user checks their wallet before trying again.
 */
async function settlePrevious(p: TariProvider, net: NetConfig) {
  const id = loadPending(net);
  if (!id) return;
  let r: any;
  try {
    r = await p.request({ method: "tari_getTransactionRequest", params: { requestId: id } });
  } catch {
    savePending(net, null);
    throw new Error("Your wallet no longer knows an earlier Lockbox transaction from this browser. Check your wallet's activity: if it went through, don't repeat it. Otherwise press again to continue.");
  }
  if (FINAL.has(r.status)) return savePending(net, null);
  const expired = typeof r.expiresAt === "number" && Date.now() > r.expiresAt;
  if (expired && r.status !== "submitting") return savePending(net, null); // never submitted, can't be now
  if (expired) {
    savePending(net, null);
    throw new Error("An earlier Lockbox transaction from this browser stopped while submitting. Check your wallet's activity: if it went through, don't repeat it. Otherwise press again to continue.");
  }
  throw new Error(`An earlier Lockbox transaction from this browser is still ${r.status} in your wallet. Approve or reject it there, then try again.`);
}

/**
 * Opens the wallet's approval popup and submits once approved. Returns the operation's result.
 * Lost responses are retried by polling the same request (the wallet lets only one submit of a
 * request execute); after repeated failures it throws with the request still recorded.
 */
export async function submit(
  p: TariProvider,
  net: NetConfig,
  instructions: Instruction[],
  onStatus: (s: string) => void,
): Promise<unknown> {
  await settlePrevious(p, net);
  const { requestId } = await p.request({
    method: "tari_createTransactionRequest",
    params: { kind: "instructions", instructions, maxFee: MAX_FEE.toString() },
  });
  savePending(net, requestId);
  const done = (result: unknown) => {
    savePending(net, null);
    const v = engineVerdict(result);
    if (v !== null && v !== "accepted") throw new Error(`The network rejected the transaction: ${v.rejected}`);
    return result;
  };
  let failures = 0;
  const lost = () =>
    new Error("Lost contact with your wallet, so the outcome is unknown. Check your wallet's activity; this page checks this transaction before starting another.");
  for (;;) {
    let r: any;
    try {
      r = await p.request({ method: "tari_getTransactionRequest", params: { requestId } });
    } catch {
      if (++failures >= 5) throw lost();
      await sleep(1500);
      continue;
    }
    switch (r.status) {
      case "approved":
        onStatus("Submitting...");
        try {
          return done(await p.request({ method: "tari_submitTransactionRequest", params: { requestId } }));
        } catch (e) {
          // Either it failed (the next poll says "failed") or the response was lost (poll again).
          if (++failures >= 5) throw lost();
          await sleep(1500);
          continue;
        }
      case "submitted":
        return done(r.result);
      case "rejected":
      case "failed":
        savePending(net, null);
        throw new Error(r.error ?? `Transaction ${r.status}.`);
      default:
        if (r.status === "pending" && typeof r.expiresAt === "number" && Date.now() > r.expiresAt) {
          savePending(net, null);
          throw new Error("The request expired in your wallet.");
        }
        onStatus(r.status === "submitting" ? "Submitting..." : "Waiting for approval in your wallet...");
        await sleep(800);
    }
  }
}
