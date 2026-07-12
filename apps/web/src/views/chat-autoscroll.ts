export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** True when the viewport bottom is within `threshold` px of the content
 *  bottom — i.e. the reader is "at the tail" and new content should keep
 *  scrolling. When the user has scrolled up past the threshold, returns false
 *  so streaming updates don't yank them back down. */
export function shouldStickToBottom(m: ScrollMetrics, threshold = 80): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}
