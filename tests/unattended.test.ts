import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";
import type { BotAdapter, InputOrder, Quote, Receipt } from "../src/types.js";

class ScriptBot implements BotAdapter {
  mode = "mock" as const;
  submissions: string[] = [];
  prepareErrors = new Map<string, string>();
  submitErrors = new Map<string, string>();
  resultErrors = new Map<string, string>();
  async balance() {
    return 200000;
  }
  async prepare(o: InputOrder): Promise<Quote> {
    if (this.prepareErrors.has(o.code))
      throw Error(this.prepareErrors.get(o.code));
    return {
      code: o.code,
      quantity: o.quantity,
      cost: 1700,
      ref: JSON.stringify({
        id: 11,
        text: "confirm",
        startMaxId: 10,
        maxId: 11,
      }),
    };
  }
  async submit(q: Quote, guard?: () => boolean) {
    if (guard && !guard()) throw Error("执行权已失效，禁止付款");
    this.submissions.push(q.code);
    if (this.submitErrors.has(q.code))
      throw Error(this.submitErrors.get(q.code));
  }
  async result(q: Quote): Promise<Receipt> {
    if (this.resultErrors.has(q.code))
      throw Error(this.resultErrors.get(q.code));
    return {
      code: q.code,
      quantity: q.quantity,
      cost: q.cost,
      balance: 100000,
      raw: "test receipt",
    };
  }
}
const codes = ["AB12CD", "EF34GH", "IJ56KL", "MN78OP", "QR90ST"];
function batch(s: Store, key = "night", targets = codes) {
  return s.createBatch(
    key,
    targets.map((code) => ({ code, quantity: 1, maxCost: 1700 })),
    targets.length * 1700,
  );
}

test("one uncertain payment is isolated and the remaining four orders execute once", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    batch(s);
    a.resultErrors.set(codes[1], "付款后未收到最终回执，请核查，禁止自动重试");
    for (let i = 0; i < 6; i++) await w.tick();
    assert.deepEqual(
      s.orders().map((o) => o.status),
      ["succeeded", "needs_review", "succeeded", "succeeded", "succeeded"],
    );
    assert.deepEqual(a.submissions, codes);
    assert.throws(() => batch(s, "duplicate", [codes[1]]), /未决/);
  } finally {
    s.close();
  }
});

test("pre-payment rejection skips and submit network uncertainty waits for a receipt without clicking twice", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    batch(s, "night", codes.slice(0, 3));
    a.prepareErrors.set(codes[0], "INVALID CODE");
    a.submitErrors.set(codes[1], "Request was unsuccessful 1 time(s)");
    for (let i = 0; i < 3; i++) await w.tick();
    assert.deepEqual(
      s.orders().map((o) => o.status),
      ["failed", "succeeded", "succeeded"],
    );
    assert.deepEqual(a.submissions, codes.slice(1, 3));
    assert.ok(
      s
        .events(s.orders()[1].id)
        .some((e: any) => /网络.*等待回执/.test(e.message)),
    );
  } finally {
    s.close();
  }
});

test("three consecutive exceptions stop the whole queue including other batches", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    batch(s, "bad", codes.slice(0, 3));
    batch(s, "later", codes.slice(3));
    for (const code of codes.slice(0, 3))
      a.prepareErrors.set(code, "INVALID CODE");
    for (let i = 0; i < 6; i++) await w.tick();
    assert.equal(a.submissions.length, 0);
    assert.deepEqual(
      s.orders().map((o) => o.status),
      ["failed", "failed", "failed", "queued", "queued"],
    );
    assert.match(s.settings("queueControl").reason, /连续3单异常/);
  } finally {
    s.close();
  }
});

test("a complete success resets the persistent exception streak", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    const b = batch(s);
    for (const code of [codes[0], codes[2], codes[3]])
      a.prepareErrors.set(code, "EXPIRED CODE");
    for (let i = 0; i < 5; i++) await w.tick();
    assert.equal(s.orders()[4].status, "succeeded");
    assert.equal(s.settings("batchStreak:" + b.id), 0);
  } finally {
    s.close();
  }
});

test("wallet shortage stops every batch before any payment", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    batch(s, "bad", [codes[0]]);
    batch(s, "next", [codes[1]]);
    a.prepareErrors.set(codes[0], "钱包余额不足");
    await w.tick();
    await w.tick();
    assert.equal(a.submissions.length, 0);
    assert.equal(s.orders()[1].status, "queued");
    assert.match(s.settings("queueControl").reason, /余额不足/);
  } finally {
    s.close();
  }
});

test("submit network uncertainty without receipt remains reviewable and is never retried", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    batch(s, "night", codes.slice(0, 2));
    a.submitErrors.set(codes[0], "ECONNRESET");
    a.resultErrors.set(codes[0], "付款后未收到最终回执");
    await w.tick();
    await w.tick();
    await w.tick();
    assert.deepEqual(
      s.orders().map((o) => o.status),
      ["needs_review", "succeeded"],
    );
    assert.deepEqual(a.submissions, codes.slice(0, 2));
  } finally {
    s.close();
  }
});

test("late receipt settles only its original isolated order and never overwrites a newer wallet", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    batch(s, "night", codes.slice(0, 2));
    a.resultErrors.set(codes[0], "付款后未收到最终回执");
    await w.tick();
    await w.tick();
    s.settings("wallet", { balance: 50000, at: "newer" });
    const late = {
      code: codes[0],
      quantity: 1,
      cost: 1700,
      balance: 190000,
      raw: "late",
      messageId: 12,
    };
    assert.equal((s as any).observeReceipt(late), true);
    assert.deepEqual(
      s.orders().map((o) => o.status),
      ["succeeded", "succeeded"],
    );
    assert.equal(s.orders()[0].actualCost, 1700);
    assert.equal(s.settings("wallet").balance, 50000);
    assert.equal((s as any).observeReceipt(late), true);
    assert.equal(
      s.events(s.orders()[0].id).filter((e: any) => /自动补录/.test(e.message))
        .length,
      1,
    );
    assert.equal((s as any).observeReceipt({ ...late, cost: 1900 }), false);
    assert.equal(s.settings("queueControl").stopped, true);
  } finally {
    s.close();
  }
});

test("a stale or mismatching late receipt cannot settle an uncertain order", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    batch(s, "night", [codes[0]]);
    a.resultErrors.set(codes[0], "付款后未收到最终回执");
    await w.tick();
    const receipt = {
      code: codes[0],
      quantity: 1,
      cost: 1700,
      balance: 190000,
      raw: "late",
    };
    assert.equal(
      (s as any).observeReceipt({ ...receipt, messageId: 9 }),
      false,
    );
    assert.equal(s.orders()[0].status, "needs_review");
    assert.equal(
      (s as any).observeReceipt({ ...receipt, messageId: 12, cost: 1900 }),
      false,
    );
    assert.equal(s.orders()[0].status, "needs_review");
    assert.equal(s.settings("queueControl").stopped, true);
  } finally {
    s.close();
  }
});

test("exception streak and queue stop survive process restart; explicit resume resets the streak", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(process.cwd(), ".test-unattended-")),
    path = join(dir, "queue.sqlite");
  let s = new Store(path);
  try {
    batch(s);
    let a = new ScriptBot();
    for (const code of codes.slice(0, 3))
      a.prepareErrors.set(code, "INVALID CODE");
    let w = new Worker(s, a);
    await w.tick();
    await w.tick();
    s.close();
    s = new Store(path);
    a = new ScriptBot();
    a.prepareErrors.set(codes[2], "INVALID CODE");
    w = new Worker(s, a);
    s.recover();
    await w.tick();
    assert.equal(s.queueControl().stopped, true);
    s.close();
    s = new Store(path);
    a = new ScriptBot();
    w = new Worker(s, a);
    s.recover();
    await w.tick();
    assert.equal(a.submissions.length, 0);
    s.resumeQueue();
    await w.tick();
    assert.equal(s.orders()[3].status, "succeeded");
    assert.equal(s.queueControl().stopped, false);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unclassified exceptions stop safely; quote caps skip but a target mismatch halts", async () => {
  for (const kind of ["unknown", "cap", "target"]) {
    const s = new Store(":memory:"),
      a = new ScriptBot(),
      w = new Worker(s, a);
    try {
      batch(s, "night", codes.slice(0, 2));
      const original = a.prepare.bind(a);
      a.prepare = async (o) => {
        if (o.code !== codes[0]) return original(o);
        if (kind === "unknown") throw Error("unexpected implementation defect");
        return {
          ...(await original(o)),
          ...(kind === "cap" ? { cost: 2000 } : { code: "ZZ99ZZ" }),
        };
      };
      await w.tick();
      await w.tick();
      assert.equal(s.orders()[0].status, "failed");
      assert.deepEqual(a.submissions, kind === "cap" ? [codes[1]] : []);
      assert.equal(s.queueControl().stopped, kind !== "cap");
    } finally {
      s.close();
    }
  }
});

test("consecutive failures across separate batches also trip the queue breaker", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    codes.forEach((code, i) => {
      batch(s, "batch-" + i, [code]);
      a.prepareErrors.set(code, "INVALID CODE");
    });
    for (let i = 0; i < 5; i++) await w.tick();
    assert.equal(s.orders().filter((o) => o.status === "failed").length, 3);
    assert.equal(s.queueControl().stopped, true);
    assert.equal(s.settings("queueStreak"), 3);
  } finally {
    s.close();
  }
});

test("late receipts are polled after a batch ends and also while the queue is stopped", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    batch(s, "night", [codes[0]]);
    a.resultErrors.set(codes[0], "付款后未收到最终回执");
    await w.tick();
    s.haltQueue("test halt");
    (a as BotAdapter).pollReceipts = async () => {
      (a as BotAdapter).onReceipt?.({
        code: codes[0],
        quantity: 1,
        cost: 1700,
        balance: 190000,
        raw: "late",
        messageId: 12,
      });
    };
    await w.tick();
    assert.equal(s.orders()[0].status, "succeeded");
    assert.equal(
      s.queueControl().stopped,
      true,
      "a late success does not silently resume a stopped queue",
    );
    assert.equal(a.submissions.length, 1);
  } finally {
    s.close();
  }
});

test("a hundred-row batch finishes every other target when row five times out", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    const targets = Array.from(
      { length: 100 },
      (_, i) => "N" + String(i).padStart(5, "0"),
    );
    batch(s, "hundred", targets);
    a.resultErrors.set(targets[4], "付款后未收到最终回执");
    for (let i = 0; i < 101; i++) await w.tick();
    assert.equal(s.orders().filter((o) => o.status === "succeeded").length, 99);
    assert.equal(s.orders()[4].status, "needs_review");
    assert.equal(new Set(a.submissions).size, 100);
    assert.equal(a.submissions.length, 100);
    const summary = s.batches()[0].counts;
    assert.equal(summary.total, 100);
    assert.equal(summary.queued, 0);
    assert.equal(summary.needs_review, 1);
    assert.equal(summary.isolated_review, 1);
  } finally {
    s.close();
  }
});

test("Telegram transport routes a late previous receipt while completing the next payment", async () => {
  const { TelegramAdapter } = await import("../src/adapters/telegram.js");
  const s = new Store(":memory:"),
    a = new ScriptBot();
  try {
    batch(s, "two", codes.slice(0, 2));
    a.resultErrors.set(codes[0], "付款后未收到最终回执");
    await new Worker(s, a).tick();
    let paid = 0;
    const confirmation = `MUSEAI TOKEN DELIVERY CONFIRMATION\nInvite Code: ${codes[1]}\nFill Target: 1B Tokens\nTotal Main Balance Cost: Rp 1700`;
    const receiptText = (code: string, balance: number) =>
      `TOKEN DELIVERED SUCCESSFULLY!\nTokens Credited: +1 Billion Tokens (1B)\nInvite Code: ${code}\nCharged from Main Balance: Rp 1700\nMain Balance Remaining (Universal): IDR ${balance}`;
    const live = new TelegramAdapter(
      {
        read: async () =>
          paid
            ? [
                { id: 30, text: receiptText(codes[0], 198300), buttons: [] },
                { id: 31, text: receiptText(codes[1], 196600), buttons: [] },
              ]
            : [
                {
                  id: 20,
                  text: confirmation,
                  buttons: [
                    {
                      text: "Yes, Process Token",
                      callback: true,
                      click: async () => {
                        paid++;
                      },
                    },
                  ],
                },
              ],
        send: async () => {},
        close: async () => {},
      },
      100,
      1,
    );
    live.prepare = async (o) => ({
      code: o.code,
      quantity: 1,
      cost: 1700,
      ref: JSON.stringify({
        id: 20,
        text: confirmation,
        startMaxId: 19,
        maxId: 20,
      }),
    });
    const next = new Worker(s, live);
    await next.tick();
    assert.deepEqual(
      s.orders().map((o) => o.status),
      ["succeeded", "succeeded"],
    );
    assert.equal(s.orders()[0].receipt?.messageId, 30);
    assert.equal(s.orders()[1].receipt?.messageId, 31);
    assert.equal(s.settings("wallet").balance, 196600);
    assert.equal(paid, 1);
  } finally {
    s.close();
  }
});

test("ambiguous late receipts stop polling from advancing to another target", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    batch(s, "first", [codes[0]]);
    await w.tick();
    s.createBatch(
      "repeat",
      [{ code: codes[0], quantity: 1, maxCost: 1700 }],
      1700,
      true,
    );
    a.resultErrors.set(codes[0], "付款后未收到最终回执");
    await w.tick();
    batch(s, "other", [codes[1]]);
    (a as BotAdapter).pollReceipts = async () => {
      (a as BotAdapter).onReceipt?.({
        code: codes[0],
        quantity: 1,
        cost: 1700,
        balance: 190000,
        raw: "ambiguous",
        messageId: 12,
      });
    };
    await w.tick();
    assert.equal(s.queueControl().stopped, true);
    assert.equal(s.orders()[2].status, "queued");
    assert.equal(a.submissions.length, 2);
  } finally {
    s.close();
  }
});

test("manually recording a partial receipt pauses the batch and preserves a newer wallet", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    const b = s.createBatch(
      "partial",
      [
        { code: codes[0], quantity: 5, maxCost: 7500 },
        { code: codes[1], quantity: 1, maxCost: 1700 },
      ],
      9200,
    );
    a.resultErrors.set(codes[0], "付款后未收到最终回执");
    await w.tick();
    s.settings("wallet", { balance: 50000, at: "newer" });
    s.resolve(s.orders()[0].id, "record_receipt", {
      code: codes[0],
      quantity: 1,
      cost: 1700,
      balance: 190000,
      raw: "manual partial",
    });
    assert.equal(s.batches().find((v) => v.id === b.id)!.paused, 1);
    assert.equal(s.orders()[0].status, "partial");
    assert.equal(s.settings("wallet").balance, 50000);
    await w.tick();
    assert.equal(a.submissions.length, 1);
  } finally {
    s.close();
  }
});

test("manual settlement binds an ambiguous receipt so resuming does not stop on the same message again", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    batch(s, "first", [codes[0]]);
    await w.tick();
    s.createBatch(
      "repeat",
      [{ code: codes[0], quantity: 1, maxCost: 1700 }],
      1700,
      true,
    );
    a.resultErrors.set(codes[0], "付款后未收到最终回执");
    await w.tick();
    const receipt = {
      code: codes[0],
      quantity: 1,
      cost: 1700,
      balance: 190000,
      raw: "ambiguous late receipt",
      messageId: 22,
    };
    assert.equal(s.observeReceipt(receipt), false);
    assert.equal(s.queueControl().stopped, true);
    s.resolve(s.orders()[1].id, "record_receipt", {
      ...receipt,
      messageId: undefined,
    });
    s.resumeQueue();
    assert.equal(s.observeReceipt(receipt), true);
    assert.equal(s.queueControl().stopped, false);
    assert.equal(s.settings("receiptMessage:22").orderId, s.orders()[1].id);
  } finally {
    s.close();
  }
});

test("an explicitly dismissed ambiguous receipt is remembered without retrying payment", async () => {
  const s = new Store(":memory:"),
    a = new ScriptBot(),
    w = new Worker(s, a);
  try {
    batch(s, "first", [codes[0]]);
    await w.tick();
    s.createBatch(
      "repeat",
      [{ code: codes[0], quantity: 1, maxCost: 1700 }],
      1700,
      true,
    );
    a.resultErrors.set(codes[0], "付款后未收到最终回执");
    await w.tick();
    const receipt = {
      code: codes[0],
      quantity: 1,
      cost: 1700,
      balance: 190000,
      raw: "ambiguous",
      messageId: 22,
    };
    s.observeReceipt(receipt);
    s.resolve(s.orders()[1].id, "not_charged", undefined, 22);
    s.resumeQueue();
    assert.equal(s.observeReceipt(receipt), true);
    assert.equal(s.queueControl().stopped, false);
    assert.equal(s.orders()[1].status, "failed");
    assert.equal(s.settings("receiptMessage:22").orderId, "ignored:22");
    await w.tick();
    assert.equal(a.submissions.length, 2);
  } finally {
    s.close();
  }
});
