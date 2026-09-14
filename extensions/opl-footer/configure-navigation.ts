export function nextTabIndex(activeTab: number, direction: "left" | "right", count: number): number {
  return direction === "left"
    ? (activeTab + count - 1) % count
    : (activeTab + 1) % count;
}

export function restoreSelectedItem(
  lists: Array<{ selectItem(id: string): void }>,
  activeTab: number,
  id: string,
): void {
  lists[activeTab]?.selectItem(id);
}
