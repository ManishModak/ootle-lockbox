/**
 * Banner shown on every page while this browser has a transaction whose outcome it hasn't
 * confirmed (see the tracking rules in wallet.ts). Its button settles that transaction directly,
 * so recovery never depends on a page's own form being usable (a spent balance, a claimed lock).
 */
import type { NetConfig } from "../config";
import { h, notice } from "../ui";
import { connect, getProvider, hasSavedRequest, settleEarlier, walletNetwork } from "../wallet";
import { showTxError } from "./lock";

export function pendingBanner(net: NetConfig): HTMLElement | null {
  if (!hasSavedRequest(net)) return null;
  const status = h("span", { "aria-live": "polite" });
  const btn = h("button", { type: "button", class: "ghost small" }, "Check it now");
  btn.addEventListener("click", async () => {
    btn.setAttribute("disabled", "");
    try {
      const p = await getProvider();
      if (!p) throw new Error("Sapient wallet not found in this browser.");
      const wn = await walletNetwork(p);
      if (wn !== net.walletNetwork) throw new Error(`Your wallet is on ${wn}. Switch it to ${net.label}.`);
      await connect(p);
      await settleEarlier(p, net, (t) => (status.textContent = t));
      status.textContent = "It never ran. You can carry on.";
    } catch (e) {
      showTxError(net, status, e);
    }
    if (hasSavedRequest(net)) btn.removeAttribute("disabled");
    else btn.remove();
  });
  return notice("warn", h("strong", {}, "A transaction from this browser isn't confirmed yet. "), "New transactions wait until it is. ", btn, " ", status);
}
