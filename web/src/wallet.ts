/**
 * Sapient wallet bridge (`window.tari`, docs: github.com/chironbuilds/tari-wallet docs/integration).
 * Builds Lockbox transactions with the Ootle SDK and submits them through the wallet's
 * create/approve/submit flow; the pending request id is kept so a reload can resume it.
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

const PENDING_KEY = "lockbox.pendingRequest";

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

/** Runs the transaction without submitting; no approval popup. Throws with the engine's reason. */
export async function dryRun(p: TariProvider, instructions: Instruction[]): Promise<unknown> {
  return p.request({ method: "tari_signAndSubmitTransaction", params: { instructions, dryRun: true } });
}

/** Opens the wallet's approval popup and submits once approved. Resumable after a reload. */
export async function submit(
  p: TariProvider,
  instructions: Instruction[],
  onStatus: (s: string) => void,
): Promise<unknown> {
  const { requestId } = await p.request({
    method: "tari_createTransactionRequest",
    params: { kind: "instructions", instructions, maxFee: "50000" },
  });
  storePending(requestId);
  return waitForRequest(p, requestId, onStatus);
}

export async function waitForRequest(p: TariProvider, requestId: string, onStatus: (s: string) => void): Promise<unknown> {
  try {
    for (;;) {
      const r = await p.request({ method: "tari_getTransactionRequest", params: { requestId } });
      switch (r.status) {
        case "approved":
          onStatus("Submitting...");
          return await p.request({ method: "tari_submitTransactionRequest", params: { requestId } });
        case "submitted":
          return r.result;
        case "rejected":
        case "failed":
          throw new Error(r.error ?? `Transaction ${r.status}.`);
        default:
          onStatus(r.status === "submitting" ? "Submitting..." : "Waiting for approval in your wallet...");
          await new Promise((res) => setTimeout(res, 800));
      }
    }
  } finally {
    storePending(null);
  }
}

function storePending(id: string | null) {
  try {
    if (id) localStorage.setItem(PENDING_KEY, id);
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage may be unavailable (private mode); resuming after a reload is then not possible.
  }
}

export function pendingRequest(): string | null {
  try {
    return localStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}
