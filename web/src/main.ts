/**
 * Lockbox web app entry: hash router (`#/<network>/<page>/<id>`) plus the shared header and footer.
 * Hash routes keep it a static site, so it runs on GitHub Pages with no server.
 */
import "./style.css";
import { DEFAULT_NETWORK, NETWORKS, REPO_URL, type NetConfig, type NetworkName } from "./config";
import { h } from "./ui";
import { createView } from "./views/create";
import { homeView } from "./views/home";
import { launchView } from "./views/launch";
import { launchFormView } from "./views/launchform";
import { lockView } from "./views/lock";
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
  return h(
    "header",
    { class: "top" },
    h("a", { href: `#/${net.name}`, class: "brand" }, h("span", { class: "logo", "aria-hidden": "true" }), "Lockbox"),
    h("nav", {}, h("a", { href: `#/${net.name}/create` }, "Create"), select),
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
      ". Lockbox is software, not an offer of any token; it holds nothing for anyone and charges no fee.",
    ),
  );
}

async function render() {
  const route = parseRoute();
  const main = h("main");
  document.body.replaceChildren(header(route.net), main, footer());
  window.scrollTo(0, 0);
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
