import test from "node:test";
import assert from "node:assert/strict";
import { sidebarDrag, SIDEBAR_CLOSE_DISTANCE, SIDEBAR_MIN_WIDTH } from "../src/lib/sidebar";

test("sidebar resists collapse until the pointer travels past the close distance", () => {
  assert.deepEqual(sidebarDrag(300, 1200), { width: 300, close: false });
  const resisted = sidebarDrag(170, 1200);
  assert.equal(resisted.close, false);
  assert.ok(resisted.width > 170 && resisted.width < SIDEBAR_MIN_WIDTH);
  assert.equal(sidebarDrag(SIDEBAR_MIN_WIDTH - SIDEBAR_CLOSE_DISTANCE + 1, 1200).close, false);
  assert.equal(sidebarDrag(SIDEBAR_MIN_WIDTH - SIDEBAR_CLOSE_DISTANCE, 1200).close, true);
  assert.equal(sidebarDrag(600, 700).width, 380);
});
