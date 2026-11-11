/** Home: what Lockbox is, a lookup box, and the most recent locks on this network. */
import { NETWORKS, REPO_URL, type NetConfig } from "../config";
import { currentEpoch, lockCreatedEvents } from "../indexer";
import { loadLock, mapLimit, type LoadedLock } from "../lockdata";
import { errorText, h, link, loading, notice } from "../ui";
import { lockTable } from "./token";

const RECENT = 15;

const TESTNET = NETWORKS.esmeralda;

/** "Lockbox's mainnet template isn't published yet." as a notice, for a network without the template. */
function notPublishedText(net: NetConfig, product: string): HTMLElement {
  const where = net.name === "mainnet" ? "mainnet" : net.label;
  return notice("info", h("strong", {}, `${product}${product.endsWith("s") ? "'" : "'s"} ${where} template isn't published yet.`));
}

/**
 * The not-published notice plus the next step: the same page on the testnet. `path` is the page's
 * route without the network ("create", "launch", "launch/<id>").
 */
export function notPublishedNotice(net: NetConfig, product = "Lockbox", path = "", action = `Try on ${TESTNET.label}`): HTMLElement {
  return h(
    "div",
    {},
    notPublishedText(net, product),
    h("div", { class: "row" }, h("a", { href: `#/${TESTNET.name}/${path}`, class: "button" }, action)),
  );
}

export async function homeView(net: NetConfig, root: HTMLElement) {
  const lookup = h("input", {
    type: "text",
    name: "q",
    placeholder: "component_… or resource_…",
    "aria-label": "Lock or token address",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const lookupError = h("p", { class: "error", "aria-live": "polite" });
  const form = h("form", { class: "lookup" }, lookup, h("button", { type: "submit" }, "Check"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = lookup.value.trim();
    if (/^component_[0-9a-f]{64}$/i.test(q)) location.hash = `#/${net.name}/lock/${q}`;
    else if (/^resource_[0-9a-f]{64}$/i.test(q)) location.hash = `#/${net.name}/token/${q}`;
    else lookupError.textContent = "Paste a full lock (component_…) or token (resource_…) address.";
  });

  const howItWorks = h("button", { type: "button", class: "ghost", onclick: () => document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }) }, "How it works");
  // Without the template here, the first action is the testnet, where both templates are published.
  const actions = net.lockboxTemplate
    ? [h("div", { class: "row" }, link(net, "create", "Create a lock", "button"), howItWorks)]
    : [notPublishedText(net, "Lockbox"), h("div", { class: "row" }, h("a", { href: `#/${TESTNET.name}`, class: "button" }, `Try on ${TESTNET.label}`), howItWorks)];
  root.append(
    h(
      "section",
      { class: "hero" },
      h("h1", {}, "Time-lock tokens on Tari Ootle.", h("br"), "Anyone can check."),
      h(
        "div",
        { class: "hero-copy" },
        h(
          "p",
          { class: "lede" },
          "Lock tokens for a beneficiary until an epoch. Nobody, including you, can take them out early unless the token's own rules allow it — every lock's public proof page checks. No Lockbox fee; network fees apply.",
        ),
        ...actions,
      ),
      h(
        "section",
        { class: "panel check-panel", "aria-labelledby": "check-title" },
        h("h2", { id: "check-title" }, "Check a lock or a token"),
        h("p", { class: "muted small" }, "Paste a lock (component_…) or token (resource_…) address to open its proof page."),
        form,
        lookupError,
      ),
    ),
  );

  if (net.lockboxTemplate) {
    const recent = h("section", { class: "recent" }, h("h2", {}, "Recent locks"), loading());
    root.append(recent);
    void loadRecent(net, recent);
  }

  root.append(
    h(
      "section",
      { class: "launch-band", "aria-labelledby": "launch-band-title" },
      h(
        "div",
        {},
        h("h2", { id: "launch-band-title" }, "Launch Commitments"),
        h(
          "p",
          {},
          "Creates a fixed-supply token that nobody, you included, can ever mint, burn, freeze or change, and locks the allocations you choose in Lockbox, in one transaction.",
        ),
      ),
      link(net, "launch", "Launch a token", "button ghost"),
    ),
    h(
      "section",
      { id: "how", class: "explain" },
      h("h2", {}, "How it works"),
      h(
        "ol",
        { class: "steps" },
        h("li", {}, "You lock tokens with your wallet: amount, unlock epoch, beneficiary key and an optional memo."),
        h("li", {}, "Lockbox creates a lock that holds them. It has no owner, no admin and no upgrade path, so it can only do one thing."),
        h("li", {}, "From the unlock epoch, only the beneficiary can claim, and gets everything in one step."),
        h("li", {}, "Anyone can open the lock's proof page and check it against the chain."),
      ),
      h(
        "div",
        { class: "caveat" },
        h("h2", {}, "What a lock does not cover"),
        h(
          "p",
          {},
          "A lock can't override the token's own rules. If the token's issuer kept the power to recall, freeze or block transfers, or owns the token, they could still undo a lock. The proof page reads the token's rules and only shows ",
          h("strong", {}, "Verified"),
          " when no such power exists.",
        ),
      ),
      h(
        "p",
        { class: "muted small fine" },
        "Epochs, not dates, decide when a lock opens. Epoch length varies, so dates shown here are estimates; a new lock is set to open after the time you pick, assuming epochs don't run much faster than usual. Epochs count base-layer blocks, so if Tari ever changes how many blocks make an epoch, locks would open at a different time. Locks hold public token balances; private TARI must be made public in your wallet first. ",
        h("a", { href: REPO_URL }, "Source code (MIT)"),
        ".",
      ),
    ),
  );
}

async function loadRecent(net: NetConfig, section: HTMLElement) {
  try {
    const [epoch, { events }] = await Promise.all([currentEpoch(net), lockCreatedEvents(net, 2)]);
    const locks = await mapLimit(events.slice(0, RECENT), 4, (e) => loadLock(net, e.lock, epoch).catch(() => null));
    section.lastElementChild?.remove();
    section.append(lockTable(net, locks.filter((x): x is LoadedLock => x !== null), null, epoch));
  } catch (e) {
    section.lastElementChild?.replaceWith(notice("warn", `Could not load recent locks: ${errorText(e)}`));
  }
}
