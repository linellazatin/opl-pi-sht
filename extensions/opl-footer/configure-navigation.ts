export function nextTabIndex(activeTab: number, direction: "left" | "right", count: number): number {
  return direction === "left"
    ? (activeTab + count - 1) % count
    : (activeTab + 1) % count;
}
