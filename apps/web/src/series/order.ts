/** Move one entry of a list (drag and drop, or the ↑/↓ buttons). Out-of-range moves are no-ops. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** "Book 2", "Book 1.5", or nothing for unnumbered books. */
export function positionLabel(position: number | null): string {
  if (position == null) return "";
  return `Book ${Number.isInteger(position) ? position : position.toFixed(1).replace(/\.0$/, "")}`;
}
