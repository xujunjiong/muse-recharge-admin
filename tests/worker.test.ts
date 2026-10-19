import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";
import { MockAdapter } from "../src/adapters/mock.js";
const row = { code: "AB12CD", quantity: 1, maxCost: 1700 };
function setup() {
  const s = new Store(":memory:");
  const a = new MockAdapter();
  const w = new Worker(s, a);
  return { s, a, w };
}
test("idempotent creation, payload mismatch and duplicate targets", () => {
  const { s } = setup();
  const b = s.createBatch("key", [row], 1700);
  assert.equal(s.createBatch("key", [row], 1700).id, b.id);
  assert.throws(
    () => s.createBatch("key", [{ ...row, code: "EF34GH" }], 1700),
    /请求/,
  );
  assert.throws(() => s.createBatch("other", [row], 1700), /重复|未决/);
  s.close();
});
test("rejects budget underflow and duplicate rows", () => {
  const { s } = setup();
  assert.throws(() => s.createBatch("k", [row], 1699), /预算/);
  assert.throws(() => s.createBatch("k", [row, row], 3400), /重复/);
  s.close();
});
test("successful order is charged exactly once and persisted", async () => {
  const { s, w, a } = setup();
  s.createBatch("k", [row], 1700);
  await w.tick();
  await w.tick();
  assert.equal(s.orders()[0].status, "succeeded");
  assert.equal(s.orders()[0].actualCost, 1700);
  assert.equal(a.submissions, 1);
  s.close();
});
test("known receipt timeout isolates its target and permits the next distinct target", async () => {
  const { s, w, a } = setup();
  a.scenario = "timeout";
  const b = s.createBatch("k", [row, { ...row, code: "EF34GH" }], 3400);
  await w.tick();
  assert.equal(s.orders()[0].status, "needs_review");
  await w.tick();
  assert.equal(a.submissions, 2);
  assert.equal(s.orders()[1].status, "needs_review");
  assert.throws(() => s.createBatch("duplicate", [row], 1700), /未决/);
  s.close();
});
test("quote increase and target mismatch never submit payment", async () => {
  for (const scenario of ["price", "wrongCode"] as const) {
    const { s, w, a } = setup();
    a.scenario = scenario;
    s.createBatch("k", [row], 1700);
    await w.tick();
    assert.equal(a.submissions, 0);
    assert.equal(s.orders()[0].status, "failed");
    assert.equal(s.queueControl().stopped, scenario === "wrongCode");
    s.close();
  }
});
test("pause while preparing prevents payment, including cancellation race", async () => {
  const { s, w, a } = setup();
  const b = s.createBatch("k", [row], 1700);
  a.onPrepare = () => s.pause(b.id);
  await w.tick();
  assert.equal(a.submissions, 0);
  assert.equal(s.orders()[0].status, "queued");
  s.close();
});
test("restart converts payment uncertainty to needs_review, never queued", () => {
  const { s } = setup();
  s.createBatch("k", [row], 1700);
  const o = s.claim()!;
  s.beginPayment(o.id, { code: row.code, quantity: 1, cost: 1700 });
  s.recover();
  assert.equal(s.orders()[0].status, "needs_review");
  assert.equal(s.claim(), null);
  s.close();
});
test("partial delivery and wrong receipt require review, never retry", async () => {
  for (const scenario of ["partial", "wrongReceipt"] as const) {
    const { s, w, a } = setup();
    a.scenario = scenario;
    s.createBatch("k", [{ ...row, quantity: 5, maxCost: 7500 }], 7500);
    await w.tick();
    assert.equal(
      s.orders()[0].status,
      scenario === "partial" ? "partial" : "needs_review",
    );
    await w.tick();
    assert.equal(a.submissions, 1);
    s.close();
  }
});
test("success target cannot be recharged without explicit duplicate permission", async () => {
  const { s, w } = setup();
  s.createBatch("k", [row], 1700);
  await w.tick();
  assert.throws(() => s.createBatch("j", [row], 1700), /重复/);
  assert.ok(s.createBatch("j", [row], 1700, true));
  s.close();
});
test("a second worker cannot run against the same database while lease is held", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(process.cwd(), ".test-lock-"));
  const s1 = new Store(join(dir, "q.sqlite")),
    s2 = new Store(join(dir, "q.sqlite"));
  try {
    new Worker(s1, new MockAdapter());
    assert.throws(() => new Worker(s2, new MockAdapter()), /已有执行器/);
  } finally {
    s1.close();
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("review resolution cannot record cost above persisted quote or batch budget", () => {
  const { s } = setup();
  const b = s.createBatch("k", [{ ...row, maxCost: 2000 }], 2000);
  const o = s.claim()!;
  s.beginPayment(o.id, { code: row.code, quantity: 1, cost: 1700 });
  s.recover();
  assert.throws(
    () =>
      s.resolve(o.id, "record_receipt", {
        code: row.code,
        quantity: 1,
        cost: 1900,
        balance: 1000,
        raw: "receipt",
      }),
    /回执|预算/,
  );
  s.close();
});
test("an expired lease cannot be stolen from a suspended but live process", () => {
  const { s } = setup();
  s.db.prepare("UPDATE worker_lock SET expires=0").run();
  s.owner = "replacement-process-token";
  assert.equal(s.acquireWorker(), false);
  s.close();
});
test("database mode prevents executing simulated orders through live adapter", () => {
  const { s } = setup();
  s.enforceMode("mock");
  s.createBatch("k", [row], 1700);
  assert.throws(() => s.enforceMode("telegram"), /模式|数据库/);
  s.close();
});
