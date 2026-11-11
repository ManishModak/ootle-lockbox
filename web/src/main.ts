/**
 * Lockbox web app entry: hash router (`#/<network>/<page>/<id>`) plus the shared header and footer.
 * Hash routes keep it a static site, so it runs on GitHub Pages with no server.
 */
import "./style.css";
import { DEFAULT_NETWORK, NETWORKS, REPO_URL, type NetConfig, type NetworkName } from "./config";
import { h, logo, startPage } from "./ui";
import { createView } from "./views/create";
import { homeView } from "./views/home";
import { launchView } from "./views/launch";
import { launchFormView } from "./views/launchform";
import { lockView } from "./views/lock";
import { pendingBanner } from "./views/pending";
import { tokenView } from "./views/token";

interface Route {
  net: NetConfig;
  page: string;
  id: string;
}

function parseRoute(): Route {
  const [n, page = "", id = ""] = location.hash.replace(/^#\/?/, "").split("/");
  const net = NETWORKS[(n as NetworkName) in NETWORKS ? (n as NetworkName) : DEFAULT_NETWORK];
  return { net, page, id };
}

function header(net: NetConfig): HTMLElement {
  const select = h(
    "select",
    { "aria-label": "Network" },
    ...Object.values(NETWORKS).map((c) => h("option", { value: c.name, selected: c.name === net.name }, c.label)),
  ) as HTMLSelectElement;
  select.addEventListener("change", () => (location.hash = `#/${select.value}`));
  // Only the form pages themselves are "current": a launch proof shares the "launch" route but isn't the form.
  const here = parseRoute();
  const navLink = (page: string, text: string) =>
    h("a", { href: `#/${net.name}/${page}`, "aria-current": here.page === page && here.id === "" ? "page" : undefined }, text);
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      { class: "top-inner" },
      h("a", { href: `#/${net.name}`, class: "brand" }, logo(), "Lockbox"),
      h("nav", { "aria-label": "Main" }, navLink("create", "Create a lock"), navLink("launch", "Launch a token")),
      h("span", { class: `net net-${net.name}` }, h("span", { class: "net-dot", "aria-hidden": "true" }), select),
    ),
  );
}

function footer(): HTMLElement {
  return h(
    "footer",
    {},
    h(
      "p",
      {},
      "Open source (MIT) · ",
      h("a", { href: REPO_URL }, "GitHub"),
      " · Built on ",
      h("a", { href: "https://ootle.tari.com" }, "Tari Ootle"),
      ". Lockbox is software, not an offer of any token, and holds nothing for anyone. Locks carry no Lockbox fee; launching a token charges a flat launch fee, shown before you sign.",
    ),
  );
}

async function render() {
  startPage();
  const route = parseRoute();
  const main = h("main");
  document.body.replaceChildren(header(route.net), main, footer());
  window.scrollTo(0, 0);
  const banner = pendingBanner(route.net);
  if (banner) main.append(banner);
  const valid = (prefix: string) => new RegExp(`^${prefix}_[0-9a-f]{64}$`, "i").test(route.id);
  if (route.page === "lock" && valid("component")) await lockView(route.net, route.id.toLowerCase(), main);
  else if (route.page === "token" && valid("resource")) await tokenView(route.net, route.id.toLowerCase(), main);
  else if (route.page === "launch" && valid("resource")) await launchView(route.net, route.id.toLowerCase(), main);
  else if (route.page === "launch" && route.id === "") await launchFormView(route.net, main);
  else if (route.page === "create") await createView(route.net, main);
  else await homeView(route.net, main);
}

window.addEventListener("hashchange", () => void render());
void render();
