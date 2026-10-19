import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../src/store.js";
import { BatchList } from "../web/BatchList.js";

function render(store: Store) {
  return renderToStaticMarkup(
    React.createElement(BatchList, {
      batches: store.batches(),
      busy: false,
      onAction() {},
      onReview() {},
    }),
  );
}
function create(store: Store, code: string) {
  return store.createBatch(code, [{ code, quantity: 1, maxCost: 1700 }], 1700);
}

test("completed paused batch is inside closed history with counts and no execution controls", () => {
  const s = new Store(":memory:");
  try {
    const b = create(s, "AB12CD");
    s.cancel(s.orders()[0].id);
    s.pause(b.id);
    const html = render(s);
    assert.match(html, /<details class="batch-history">/);
    assert.ok(html.indexOf(b.id.slice(0, 8)) > html.indexOf("<details"));
    assert.match(html, /成功 0 \/ 失败 0 \/ 取消 1/);
    assert.doesNotMatch(html, /恢复执行|暂停后续/);
  } finally {
    s.close();
  }
});

test("review and partial delivery stay outside history and review offers an action", () => {
  const s = new Store(":memory:");
  try {
    const review = create(s, "AB12CD"),
      partial = create(s, "EF34GH"),
      done = create(s, "IJ56KL");
    for (const o of s.orders()) {
      s.setStatus(
        o.id,
        o.batchId === review.id
          ? "needs_review"
          : o.batchId === partial.id
            ? "partial"
            : "succeeded",
        "test",
      );
      s.pause(o.batchId);
    }
    const html = render(s),
      historyStart = html.indexOf("<details");
    assert.ok(html.indexOf(review.id.slice(0, 8)) < historyStart);
    assert.ok(html.indexOf(partial.id.slice(0, 8)) < historyStart);
    assert.ok(html.indexOf(done.id.slice(0, 8)) > historyStart);
    assert.match(html, /去核查/);
    assert.match(html, /部分交付 1 笔，请核对/);
    assert.doesNotMatch(html, /恢复执行/);
  } finally {
    s.close();
  }
});

test("resume appears only for a paused queued batch and disappears after its last cancellation", () => {
  const s = new Store(":memory:");
  try {
    const b = create(s, "AB12CD");
    s.pause(b.id);
    assert.equal(s.batches()[0].canResume, true);
    assert.match(render(s), /恢复执行/);
    s.resume(b.id);
    assert.equal(s.batches()[0].canResume, false);
    assert.match(render(s), /暂停后续/);
    s.cancel(s.orders()[0].id);
    assert.equal(s.batches()[0].finished, true);
    assert.doesNotMatch(render(s), /恢复执行|暂停后续/);
  } finally {
    s.close();
  }
});

test("batch lists sort by creation time and do not archive an unexpected empty batch", () => {
  const s = new Store(":memory:");
  try {
    const first = create(s, "AB12CD"),
      second = create(s, "EF34GH");
    s.db
      .prepare("UPDATE batches SET createdAt=? WHERE id=?")
      .run("2030-01-01T00:00:00.000Z", first.id);
    assert.equal(s.batches()[0].id, first.id);
    s.db.prepare("DELETE FROM orders WHERE batchId=?").run(second.id);
    assert.equal(s.batches().find((b) => b.id === second.id)!.finished, false);
  } finally {
    s.close();
  }
});
