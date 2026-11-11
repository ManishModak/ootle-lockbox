/**
 * "Unlock after" for the create and launch forms: quick lengths (1 week to 2 years) or "Pick a
 * date", one plain line with the estimate, and the working in a small "How is this worked out?".
 * The form reads `target()`, the chosen time; the unlock epoch is computed from it as before.
 */
import type { NetConfig } from "../config";
import { LOCK_LENGTHS, lockLengthTarget, toLocalInput, type LockLength } from "../locklength";
import { unlockEpochFor } from "../newlock";
import { epochsAsDuration, estimatedDate, formatDate, h } from "../ui";

export interface UnlockPicker {
  el: HTMLElement;
  /** The chosen time in ms, or NaN when nothing (or no valid date) is chosen. */
  target(): number;
}

/** `id` names the date input (its label points at it); `epoch` is the current epoch, for the preview. */
export function unlockPicker(net: NetConfig, epoch: number, id: string): UnlockPicker {
  const name = `${id}-length`;
  const date = h("input", { id, type: "datetime-local" }) as HTMLInputElement;
  const dateField = h("div", { class: "unlock-date", hidden: true }, h("label", { for: id }, "Unlock date and time"), date);
  const radio = (value: string, label: string) =>
    h("label", { class: "chip" }, h("input", { type: "radio", name, value }), h("span", {}, label));
  const chips = h("div", { class: "chips" }, ...LOCK_LENGTHS.map((l) => radio(l.id, l.label)), radio("date", "Pick a date"));
  const line = h("p", { class: "unlock-line", "aria-live": "polite" }, "Choose how long to lock for.");
  const how = h("p", { class: "muted small" });
  const details = h("details", { class: "unlock-how", hidden: true }, h("summary", {}, "How is this worked out?"), how);

  // A quick length is fixed when picked, like a typed date; "Pick a date" starts from it.
  let presetTarget = Number.NaN;
  const chosen = () => (chips.querySelector("input:checked") as HTMLInputElement | null)?.value ?? "";
  const target = () => (chosen() === "date" ? (date.value ? Date.parse(date.value) : Number.NaN) : chosen() ? presetTarget : Number.NaN);

  const update = () => {
    const t = target();
    const e = unlockEpochFor(net, epoch, t, Date.now());
    details.hidden = e === null;
    if (e === null) {
      line.textContent = chosen() === "" ? "Choose how long to lock for." : "Pick a date and time in the future.";
      return;
    }
    line.replaceChildren(
      "Opens around ",
      h("strong", {}, estimatedDate(net, e, epoch)),
      h("span", { class: "muted" }, " · not before "),
      formatDate(t),
      h("span", { class: "muted" }, " unless epochs speed up"),
    );
    how.textContent =
      `It opens at epoch ${e}, ${epochsAsDuration(net, e - epoch)} from now (the chain is at epoch ${epoch}). ` +
      `Epochs on ${net.label} usually take about ${net.epochMinutes.typical} minutes, which gives the date above. ` +
      `To be safe, the lock counts each epoch as only ${net.epochMinutes.min} minutes, the shortest we expect, so it can't open before the time you chose. ` +
      `If epochs ever ran shorter than that, it would open earlier.`;
  };

  chips.addEventListener("change", () => {
    const v = chosen();
    if (v === "date") {
      if (!date.value && Number.isFinite(presetTarget)) date.value = toLocalInput(presetTarget);
    } else presetTarget = lockLengthTarget(v as LockLength, Date.now());
    dateField.hidden = v !== "date";
    update();
  });
  date.addEventListener("input", update);

  const el = h("fieldset", { class: "unlock-picker" }, h("legend", {}, "Unlock after"), chips, dateField, line, details);
  return { el, target };
}

/**
 * A reviewed unlock: the epoch, then the estimate and the earliest time on their own line, with
 * the assumption the earliest time rests on. Used by both reviews.
 */
export function unlockTerms(net: NetConfig, unlockEpoch: number, epoch: number, target: number): (Node | string)[] {
  return [
    `epoch ${unlockEpoch}`,
    h("span", { class: "muted block" }, `Opens around ${estimatedDate(net, unlockEpoch, epoch)}. Not before ${formatDate(target)}, as long as epochs take at least ${net.epochMinutes.min} minutes.`),
  ];
}
