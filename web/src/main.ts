/**
 * Lockbox web app entry: hash router (`#/<network>/<page>/<id>`) plus the shared header and footer.
 * Hash routes keep it a static site, so it runs on GitHub Pages with no server.
 */
import "./style.css";
import { DEFAULT_NETWORK, NETWORKS, REPO_URL, type NetConfig, type NetworkName } from "./config";
import { networkMenu } from "./netmenu";
import { h, logo, reducedMotion, startPage } from "./ui";
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
      networkMenu(net),
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
      ". Lockbox is software. It holds nothing for anyone and offers no token. Locks have no Lockbox fee. Launching a token has a flat fee, shown before you sign.",
    ),
  );
}

/**
 * Shows the page for the current hash. The swap itself is synchronous (each view puts up its
 * frame and loading placeholders before its first await), so a route change can cross-fade with
 * the View Transitions API where supported. The first render and reduced motion swap plainly.
 */
function render(animate: boolean) {
  const swap = () => {
    startPage();
    const route = parseRoute();
    const main = h("main");
    document.body.replaceChildren(header(route.net), main, footer());
    window.scrollTo(0, 0);
    void showPage(route, main);
  };
  if (animate && document.startViewTransition && !reducedMotion()) document.startViewTransition(swap);
  else swap();
}

async function showPage(route: Route, main: HTMLElement) {
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

window.addEventListener("hashchange", () => render(true));
render(false);
