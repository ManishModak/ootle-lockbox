import { describe, expect, it, vi } from "vitest";
import { beginPage, onThisPage } from "./ui";

describe("beginPage", () => {
  it("makes the page being left stop being this page at once, before its replacement is drawn", () => {
    beginPage(() => {})();
    const oldPage = onThisPage();
    expect(oldPage()).toBe(true);
    const show = vi.fn();
    const swap = beginPage(show); // a hashchange; a view transition would call `swap` a frame later
    expect(oldPage()).toBe(false);
    expect(show).not.toHaveBeenCalled();
    swap();
    expect(show).toHaveBeenCalledOnce();
    expect(oldPage()).toBe(false);
  });

  it("never counts a flow started on the old page while the new one is still pending", () => {
    beginPage(() => {})();
    const swap = beginPage(() => {});
    const startedInGap = onThisPage();
    swap();
    expect(startedInGap()).toBe(false);
    expect(onThisPage()()).toBe(true);
  });

  it("does nothing for a swap that a newer navigation superseded", () => {
    const first = vi.fn();
    const second = vi.fn();
    const swapFirst = beginPage(first);
    const swapSecond = beginPage(second);
    swapFirst(); // the skipped transition still runs its callback
    expect(first).not.toHaveBeenCalled();
    swapSecond();
    expect(second).toHaveBeenCalledOnce();
    expect(onThisPage()()).toBe(true);
  });
});
