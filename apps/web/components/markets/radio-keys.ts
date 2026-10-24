import type { KeyboardEvent } from "react";

/**
 * Arrow-key navigation for a group of role="radio" buttons (WAI-ARIA radio
 * group pattern): arrows move selection and focus, wrapping at the ends.
 */
export function handleRadioKeys<T>(
  event: KeyboardEvent<HTMLButtonElement>,
  values: readonly T[],
  current: T,
  select: (value: T) => void,
): void {
  const delta =
    event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (delta === 0) return;
  event.preventDefault();
  const index = values.indexOf(current);
  const nextIndex = (index + delta + values.length) % values.length;
  select(values[nextIndex]);
  const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  radios?.[nextIndex]?.focus();
}
