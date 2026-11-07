import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORKS } from "./config";
import { dryRun, engineVerdict, submit } from "./wallet";

const net = NETWORKS.esmeralda;
const accept = { finalize: { result: { Accept: {} } } };

/** A scripted wallet: `get` answers tari_getTransactionRequest, `sub` tari_submitTransactionRequest. */
function fakeWallet(opts: { get: (id: string) => unknown; sub?: () => unknown }) {
  const calls: string[] = [];
  let n = 0;
  const p = {
    isTariWallet: true,
    async request({ method, params }: { method: string; params?: any }) {
      calls.push(method);
      if (method === "tari_createTransactionRequest") return { requestId: `req${++n}` };
      if (method === "tari_getTransactionRequest") return opts.get(params.requestId);
      if (method === "tari_submitTransactionRequest") return opts.sub ? opts.sub() : accept;
      if (method === "tari_signAndSubmitTransaction") return opts.get("dry");
      throw new Error(`unexpected ${method}`);
    },
  };
  return { p, calls, creates: () => calls.filter((c) => c === "tari_createTransactionRequest").length };
}

/** Runs a promise to completion while fake timers advance. */
async function settle<T>(pr: Promise<T>): Promise<{ ok: T } | { err: Error }> {
  const out = pr.then((ok) => ({ ok }), (err: Error) => ({ err }));
  await vi.runAllTimersAsync();
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("engineVerdict / dryRun", () => {
  it("reads accept, both rejection shapes, and unknown shapes", () => {
    expect(engineVerdict(accept)).toBe("accepted");
    expect(engineVerdict({ result: accept })).toBe("accepted");
    expect(engineVerdict({ finalize: { result: { Reject: "early" } } })).toEqual({ rejected: "early" });
    expect(engineVerdict({ finalize: { result: { AcceptFeeRejectRest: [{}, { x: 1 }] } } })).toEqual({ rejected: '{"x":1}' });
    expect(engineVerdict({ ok: true })).toBeNull();
  });

  it("throws unless the engine accepted", async () => {
    await expect(dryRun(fakeWallet({ get: () => ({ result: { finalize: { result: { Reject: "no" } } } }) }).p as any, [])).rejects.toThrow("reject");
    await expect(dryRun(fakeWallet({ get: () => ({}) }).p as any, [])).rejects.toThrow("recognise");
    await expect(dryRun(fakeWallet({ get: () => accept }).p as any, [])).resolves.toBeUndefined();
  });
});

describe("submit", () => {
  it("recovers a lost submit response by polling the same request", async () => {
    let submitted = false;
    const w = fakeWallet({
      get: () => (submitted ? { status: "submitted", result: accept } : { status: "approved" }),
      sub: () => {
        submitted = true;
        throw new Error("connection lost");
      },
    });
    const r = await settle(submit(w.p as any, net, [], () => {}));
    expect(r).toEqual({ ok: accept });
    expect(w.creates()).toBe(1);
  });

  it("keeps an unknown outcome and blocks a new transaction until it is final", async () => {
    let state: unknown = "down";
    const w = fakeWallet({
      get: () => {
        if (state === "down") throw new Error("wallet unreachable");
        return state;
      },
    });
    const first = await settle(submit(w.p as any, net, [], () => {}));
    expect("err" in first && first.err.message).toContain("outcome is unknown");

    state = { status: "submitting", expiresAt: Date.now() + 60_000 };
    const blocked = await settle(submit(w.p as any, net, [], () => {}));
    expect("err" in blocked && blocked.err.message).toContain("still submitting");
    expect(w.creates()).toBe(1);

    state = { status: "submitted", result: accept };
    const next = await settle(submit(w.p as any, net, [], () => {}));
    expect(next).toEqual({ ok: accept });
    expect(w.creates()).toBe(2);
  });

  it("makes the user check their wallet once if it forgot the earlier request", async () => {
    let forgot = false;
    const w = fakeWallet({
      get: (id) => {
        if (id === "req1" && forgot) throw new Error("unknown request");
        if (id === "req1") throw new Error("wallet unreachable");
        return { status: "submitted", result: accept };
      },
    });
    await settle(submit(w.p as any, net, [], () => {}));
    forgot = true;
    const once = await settle(submit(w.p as any, net, [], () => {}));
    expect("err" in once && once.err.message).toContain("Check your wallet's activity");
    expect(await settle(submit(w.p as any, net, [], () => {}))).toEqual({ ok: accept });
  });

  it("reports an on-chain rejection instead of success", async () => {
    const w = fakeWallet({ get: () => ({ status: "submitted", result: { finalize: { result: { Reject: "too early" } } } }) });
    const r = await settle(submit(w.p as any, net, [], () => {}));
    expect("err" in r && r.err.message).toContain("too early");
  });
});
