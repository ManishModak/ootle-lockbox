import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORKS } from "./config";
import { dryRun, engineVerdict, forgetEarlierTransaction, submit, TxBlocked } from "./wallet";

const net = NETWORKS.esmeralda;
const accept = { finalize: { result: { Accept: {} } } };

/**
 * A scripted wallet. `status(id)` answers tari_getTransactionRequest (throw = transport failure);
 * `sub(id)` answers tari_submitTransactionRequest. Records every call.
 */
function fakeWallet(opts: { status: (id: string) => unknown; sub?: (id: string) => unknown; dry?: unknown }) {
  const calls: [string, string?][] = [];
  let n = 0;
  const p = {
    isTariWallet: true,
    async request({ method, params }: { method: string; params?: any }) {
      calls.push([method, params?.requestId]);
      if (method === "tari_createTransactionRequest") return { requestId: `req${++n}` };
      if (method === "tari_getTransactionRequest") return opts.status(params.requestId);
      if (method === "tari_submitTransactionRequest") return opts.sub ? opts.sub(params.requestId) : accept;
      if (method === "tari_signAndSubmitTransaction") return opts.dry;
      throw new Error(`unexpected ${method}`);
    },
  };
  const count = (m: string) => calls.filter(([c]) => c === m).length;
  return { p: p as any, calls, creates: () => count("tari_createTransactionRequest"), submits: () => calls.filter(([c]) => c === "tari_submitTransactionRequest").map(([, id]) => id) };
}

/** Runs a promise to completion while fake timers advance. */
async function settle<T>(pr: Promise<T>): Promise<{ ok: T } | { err: Error }> {
  const out = pr.then((ok) => ({ ok }), (err: Error) => ({ err }));
  await vi.runAllTimersAsync();
  return out;
}
const errOf = (r: { ok: unknown } | { err: Error }) => ("err" in r ? r.err : null);

const KEY = "lockbox.pending.esmeralda";
let store: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  // Web Locks with ifAvailable, as browsers share it across tabs.
  const held = new Set<string>();
  vi.stubGlobal("navigator", {
    locks: {
      async request(name: string, _opts: unknown, cb: (l: unknown) => Promise<unknown>) {
        if (held.has(name)) return cb(null);
        held.add(name);
        try {
          return await cb({ name });
        } finally {
          held.delete(name);
        }
      },
    },
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
    const dry = (result: unknown) => dryRun(fakeWallet({ status: () => null, dry: result }).p, []);
    await expect(dry({ result: { finalize: { result: { Reject: "no" } } } })).rejects.toThrow("reject");
    await expect(dry({})).rejects.toThrow("recognise");
    await expect(dry(accept)).resolves.toBeUndefined();
  });
});

describe("submit", () => {
  const run = (w: ReturnType<typeof fakeWallet>) => settle(submit(w.p, net, [], () => {}));

  it("recovers a lost submit response by polling the same request", async () => {
    let done = false;
    const w = fakeWallet({
      status: () => (done ? { status: "submitted", result: accept } : { status: "approved" }),
      sub: () => {
        done = true;
        throw new Error("connection lost");
      },
    });
    expect(await run(w)).toEqual({ ok: accept });
    expect(w.creates()).toBe(1);
    expect(store.has(KEY)).toBe(false);
  });

  it("times out a submit that never answers, then finds the outcome on the same request", async () => {
    let done = false;
    const w = fakeWallet({
      status: () => (done ? { status: "submitted", result: accept } : { status: "approved" }),
      sub: () => {
        done = true;
        return new Promise(() => {}); // the response is lost for good
      },
    });
    expect(await run(w)).toEqual({ ok: accept });
    expect(w.submits()).toEqual(["req1"]);
  });

  it("keeps a request stuck in submitting and lets the user forget it deliberately", async () => {
    const w = fakeWallet({ status: (id) => (id === "req1" ? { status: "submitting", expiresAt: 0 } : { status: "submitted", result: accept }) });
    const first = errOf(await run(w));
    expect(first).toBeInstanceOf(TxBlocked);
    expect((first as TxBlocked).canForget).toBe(true);
    expect(store.get(KEY)).toBe("req1");
    // Still blocked on the next attempt, without creating anything new.
    expect(errOf(await run(w))).toBeInstanceOf(TxBlocked);
    expect(w.creates()).toBe(1);
    forgetEarlierTransaction(net);
    expect(await run(w)).toEqual({ ok: accept });
    expect(w.creates()).toBe(2);
  });

  it("never forgets a saved request because the wallet didn't answer", async () => {
    store.set(KEY, "old");
    let up = false;
    const w = fakeWallet({
      status: (id) => {
        if (!up) throw new Error("wallet unreachable");
        return id === "old" ? { status: "failed", error: "boom" } : { status: "submitted", result: accept };
      },
    });
    expect(errOf(await run(w))?.message).toContain("Lost contact");
    expect(store.get(KEY)).toBe("old");
    expect(w.creates()).toBe(0);
    up = true; // the old one never executed, so the next attempt goes ahead
    expect(await run(w)).toEqual({ ok: accept });
    expect(w.creates()).toBe(1);
  });

  it("shows that a saved request went through instead of starting a new one", async () => {
    store.set(KEY, "old");
    const w = fakeWallet({ status: () => ({ status: "submitted", result: accept }) });
    const r = errOf(await run(w));
    expect(r?.message).toContain("went through");
    expect(w.creates()).toBe(0);
    expect(store.has(KEY)).toBe(false);
    expect(await run(w)).toEqual({ ok: accept }); // a separate, deliberate attempt
    expect(w.creates()).toBe(1);
  });

  it("submits a saved request that was approved before a reload, and stops there", async () => {
    store.set(KEY, "old");
    let done = false;
    const w = fakeWallet({
      status: () => (done ? { status: "submitted", result: accept } : { status: "approved" }),
      sub: () => ((done = true), accept),
    });
    expect(errOf(await run(w))?.message).toContain("went through");
    expect(w.submits()).toEqual(["old"]);
    expect(w.creates()).toBe(0);
  });

  it("refuses a second transaction while one is running", async () => {
    const w = fakeWallet({ status: () => ({ status: "submitted", result: accept }) });
    const [a, b] = await Promise.all([run(w), run(w)]);
    const blocked = [a, b].filter((r) => errOf(r)?.message.includes("Another"));
    expect(blocked).toHaveLength(1);
    expect(w.creates()).toBe(1);
  });

  it("reports an on-chain rejection instead of success", async () => {
    const w = fakeWallet({ status: () => ({ status: "submitted", result: { finalize: { result: { Reject: "too early" } } } }) });
    expect(errOf(await run(w))?.message).toContain("too early");
    expect(store.has(KEY)).toBe(false);
  });
});
