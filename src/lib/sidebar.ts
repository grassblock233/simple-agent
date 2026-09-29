export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_CLOSE_DISTANCE = 96;

export function sidebarDrag(pointerX: number, viewportWidth: number): { width: number; close: boolean } {
  const maxWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(520, viewportWidth - 320));
  const rawWidth = Math.min(pointerX, maxWidth);
  if (rawWidth <= SIDEBAR_MIN_WIDTH - SIDEBAR_CLOSE_DISTANCE) return { width: 0, close: true };
  if (rawWidth >= SIDEBAR_MIN_WIDTH) return { width: rawWidth, close: false };
  return { width: SIDEBAR_MIN_WIDTH - Math.min(28, (SIDEBAR_MIN_WIDTH - rawWidth) * 0.28), close: false };
}
