/** Home: what Lockbox is, a lookup box, and the most recent locks on this network. */
import { NETWORKS, REPO_URL, type NetConfig } from "../config";
import { currentEpoch, lockCreatedEvents } from "../indexer";
import { loadLock, mapLimit, type LoadedLock } from "../lockdata";
import { errorText, h, link, notice, reducedMotion, tableSkeleton } from "../ui";
import { LOCK_COLUMNS, lockTable } from "./token";

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

  const howItWorks = h("button", { type: "button", class: "ghost", onclick: () => document.getElementById("how")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" }) }, "How it works");
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
          "Lock tokens for a beneficiary until a set epoch. Nobody can take them out early, not even you. The one exception is a token whose own rules let its issuer pull them back, and every lock's proof page checks for that. No Lockbox fee, only network fees.",
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
    const recent = h("section", { class: "recent" }, h("h2", {}, "Recent locks"), tableSkeleton(LOCK_COLUMNS, "Loading recent locks…"));
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
          "Create a token with a fixed supply that nobody can ever mint, burn, freeze or change, not even you. The allocations you choose go into Lockbox locks in the same transaction.",
        ),
        net.launchTemplate ? null : h("p", { class: "muted small" }, `Launch Commitments isn't published on ${net.name === "mainnet" ? "mainnet" : net.label} yet.`),
      ),
      // Without the launch template here, the button goes to the testnet launch page instead of a dead end.
      net.launchTemplate
        ? link(net, "launch", "Launch a token", "button ghost")
        : h("a", { href: `#/${TESTNET.name}/launch`, class: "button ghost" }, `Launch on ${TESTNET.label}`),
    ),
    h(
      "section",
      { id: "how", class: "explain" },
      h("h2", {}, "How it works"),
      h(
        "ol",
        { class: "steps" },
        h("li", {}, "In your wallet, pick the tokens, the unlock time and who can claim them. A memo is optional."),
        h("li", {}, "Lockbox puts them in a lock with no owner, no admin and no upgrades. It can only do one thing."),
        h("li", {}, "Once the unlock epoch arrives, the beneficiary claims everything in one step. Nobody else can."),
        h("li", {}, "Anyone can open the lock's proof page and check it against the chain."),
      ),
      h(
        "div",
        { class: "caveat" },
        h("h2", {}, "What a lock does not cover"),
        h(
          "p",
          {},
          "A lock can't override the token's own rules. If the issuer kept the power to recall, freeze or block transfers, they could still undo a lock. The proof page reads those rules and shows ",
          h("strong", {}, "Verified"),
          " only when no such power exists.",
        ),
      ),
      h(
        "section",
        { class: "good-to-know", "aria-labelledby": "gtk-title" },
        h("h3", { id: "gtk-title" }, "Good to know"),
        h(
          "ul",
          {},
          h("li", {}, `Locks open at an epoch, not a date. Dates you see are estimates (an epoch is about ${NETWORKS.mainnet.epochMinutes.typical} minutes on mainnet).`),
          h("li", {}, "A new lock is set so it can't open before the time you pick, unless epochs run much faster than usual."),
          h("li", {}, "Epochs count base-layer blocks. If Tari changes how many blocks make an epoch, unlock times shift too."),
          h("li", {}, "Locks hold public balances. Make private TARI public in your wallet first."),
          h("li", {}, h("a", { href: REPO_URL }, "Open source (MIT)")),
        ),
      ),
    ),
  );
}

async function loadRecent(net: NetConfig, section: HTMLElement) {
  try {
    const [epoch, { events }] = await Promise.all([currentEpoch(net), lockCreatedEvents(net, 2)]);
    const locks = await mapLimit(events.slice(0, RECENT), 4, (e) => loadLock(net, e.lock, epoch).catch(() => null));
    section.lastElementChild?.remove();
    section.append(lockTable(net, locks.filter((x): x is LoadedLock => x !== null), epoch));
  } catch (e) {
    section.lastElementChild?.replaceWith(notice("warn", `Could not load recent locks: ${errorText(e)}`));
  }
}
