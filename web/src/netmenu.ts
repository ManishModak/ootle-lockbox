/**
 * The header's network switcher: a pill button (network dot and name) that opens a small menu of
 * networks, each with a one-line hint and a check on the current one. Picking another network
 * goes to its home page (`#/<network>`), as the old select did.
 *
 * Keyboard (menu button pattern): Enter, Space or Down opens it on the current network, Up on the
 * last; Up/Down/Home/End move; Enter or Space picks; Escape closes and returns focus to the
 * button; Tab or a click outside closes it.
 */
import { NETWORKS, type NetConfig, type NetworkName } from "./config";
import { checkIcon, h } from "./ui";

const HINTS: Record<NetworkName, string> = {
  mainnet: "Real tokens",
  esmeralda: "Test tokens, no value",
};

/** Mainnet first: it is the real one. */
const ORDER: NetworkName[] = ["mainnet", "esmeralda"];

const dot = (name: NetworkName) => h("span", { class: `net-dot net-dot-${name}`, "aria-hidden": "true" });

export function networkMenu(current: NetConfig): HTMLElement {
  const nets = ORDER.map((n) => NETWORKS[n]);
  const button = h(
    "button",
    { type: "button", class: "net-button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "net-menu", "aria-label": `Network: ${current.label}` },
    dot(current.name),
    h("span", { class: "net-name" }, current.label),
    h("span", { class: "net-chevron", "aria-hidden": "true" }),
  );
  const items = nets.map((n) =>
    h(
      "li",
      { role: "menuitemradio", tabindex: "-1", "aria-checked": n.name === current.name ? "true" : "false", "aria-describedby": `net-hint-${n.name}`, "data-net": n.name },
      dot(n.name),
      h("span", { class: "net-item-text" }, h("span", { class: "net-item-name" }, n.label), h("span", { class: "net-item-hint", id: `net-hint-${n.name}` }, HINTS[n.name])),
      n.name === current.name ? checkIcon() : h("span", { class: "check-icon", "aria-hidden": "true" }),
    ),
  );
  const menu = h("ul", { class: "net-menu", id: "net-menu", role: "menu", "aria-label": "Network" }, ...items);
  const root = h("div", { class: `net net-${current.name}` }, button, menu);

  const isOpen = () => button.getAttribute("aria-expanded") === "true";
  const focusItem = (i: number) => items[(i + items.length) % items.length].focus();
  const currentIndex = () => Math.max(0, nets.findIndex((n) => n.name === current.name));

  // A press outside closes the menu; also drops itself once the header is re-rendered.
  const outside = (e: PointerEvent) => {
    if (!root.isConnected) document.removeEventListener("pointerdown", outside);
    else if (!root.contains(e.target as Node)) close(false);
  };
  function open(focusAt: number) {
    if (!isOpen()) {
      button.setAttribute("aria-expanded", "true");
      root.classList.add("open");
      document.addEventListener("pointerdown", outside);
    }
    focusItem(focusAt);
  }
  function close(returnFocus: boolean) {
    if (!isOpen()) return;
    button.setAttribute("aria-expanded", "false");
    root.classList.remove("open");
    document.removeEventListener("pointerdown", outside);
    if (returnFocus) button.focus();
  }
  function pick(i: number) {
    const n = nets[i];
    close(true);
    if (n.name !== current.name) location.hash = `#/${n.name}`;
  }

  button.addEventListener("click", () => (isOpen() ? close(true) : open(currentIndex())));
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      open(e.key === "ArrowDown" ? currentIndex() : items.length - 1);
    }
  });
  menu.addEventListener("keydown", (e) => {
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") focusItem(i + 1);
    else if (e.key === "ArrowUp") focusItem(i - 1);
    else if (e.key === "Home") focusItem(0);
    else if (e.key === "End") focusItem(items.length - 1);
    else if (e.key === "Enter" || e.key === " ") pick(Math.max(0, i));
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") return close(false);
    else return;
    e.preventDefault();
  });
  items.forEach((it, i) => it.addEventListener("click", () => pick(i)));
  // Focus moving somewhere else on the page closes it. A null target (a click on nothing
  // focusable, or Safari's unfocusable buttons) is left to the outside-press handler.
  root.addEventListener("focusout", (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && !root.contains(to)) close(false);
  });
  return root;
}
