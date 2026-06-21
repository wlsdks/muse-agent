// Keyboard navigation for a WAI-ARIA tablist: given the current tab index and a
// key, return the index to move focus/selection to. Pure + testable so the view
// holds no key-handling logic. Left/Up = previous (wraps), Right/Down = next
// (wraps), Home = first, End = last; any other key leaves the index unchanged.
export function nextTabIndex(current: number, key: string, count: number): number {
  if (count <= 0) return 0;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return current;
  }
}
