import test from "node:test";
import assert from "node:assert/strict";
import { createApp, hashPassword } from "../src/app.js";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";
import { MockAdapter } from "../src/adapters/mock.js";
import ExcelJS from "exceljs";
async function fixture() {
  const store = new Store(":memory:"),
    adapter = new MockAdapter(),
    worker = new Worker(store, adapter);
  const server = createApp({
    store,
    adapter,
    worker,
    passwordHash: hashPassword("testing-password"),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    store,
    adapter,
    worker,
    base,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}
async function login(base: string) {
  const r = await fetch(base + "/api/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "testing-password" }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const j = await r.json();
  return { cookie, csrf: j.csrf };
}
test("authentication, CSRF, origin and private files", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.base + "/api/state")).status, 401);
    const { cookie, csrf } = await login(f.base);
    assert.equal(
      (await fetch(f.base + "/api/state", { headers: { cookie } })).status,
      200,
    );
    assert.equal(
      (
        await fetch(f.base + "/api/batches", {
          method: "POST",
          headers: {
            cookie,
            Origin: f.base,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(f.base + "/api/logout", {
          method: "POST",
          headers: {
            cookie,
            Origin: "https://evil.invalid",
            "x-csrf-token": csrf,
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(f.base + "/.env", { headers: { cookie } })).status,
      404,
    );
  } finally {
    await f.close();
  }
});
test("imports, budget preview creation, idempotent submit and mock worker result", async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await login(f.base),
      headers = { cookie, Origin: f.base, "x-csrf-token": csrf };
    await fetch(f.base + "/api/refresh-balance", {
      method: "POST",
      headers,
      body: "{}",
    });
    const w = new ExcelJS.Workbook();
    w.addWorksheet("data").addRows([
      ["邀请码", "充值量B", "单笔费用上限IDR"],
      ["AB12CD", 1, 1700],
    ]);
    const r = await fetch(f.base + "/api/import", {
      method: "POST",
      headers,
      body: Buffer.from(await w.xlsx.writeBuffer()),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    const b = {
      key: "test-batch",
      importId: data.id,
      rows: [2],
      budget: 1700,
      allowRepeat: false,
    };
    const submit = () =>
      fetch(f.base + "/api/batches", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
    const first = await submit();
    assert.equal(first.status, 200);
    const id = (await first.json()).id;
    assert.equal((await (await submit()).json()).id, id);
    await f.worker.tick();
    const state = await (
      await fetch(f.base + "/api/state", { headers: { cookie } })
    ).json();
    assert.equal(state.orders[0].status, "succeeded");
    assert.equal(f.adapter.submissions, 1);
    const exp = await fetch(f.base + "/api/export", { headers: { cookie } });
    assert.equal(exp.status, 200);
    assert.match(await exp.text(), /AB12CD/);
  } finally {
    await f.close();
  }
});
test("failed balance refresh invalidates prior wallet instead of authorizing stale funds", async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await login(f.base),
      headers = { cookie, Origin: f.base, "x-csrf-token": csrf };
    await fetch(f.base + "/api/refresh-balance", {
      method: "POST",
      headers,
      body: "{}",
    });
    f.adapter.balance = async () => {
      throw Error("connection lost");
    };
    assert.equal(
      (
        await fetch(f.base + "/api/refresh-balance", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      400,
    );
    const state = await (
      await fetch(f.base + "/api/state", { headers: { cookie } })
    ).json();
    assert.equal(state.wallet.balance, null);
  } finally {
    await f.close();
  }
});
test("parallel slow-body login requests cannot bypass attempt reservation", async () => {
  const f = await fixture();
  try {
    const { request } = await import("node:http");
    const calls = Array.from({ length: 12 }, () => {
      let send!: () => void;
      const result = new Promise<number>((resolve, reject) => {
        const req = request(
          f.base + "/api/login",
          {
            method: "POST",
            headers: { Origin: f.base, "Content-Type": "application/json" },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode!));
          },
        );
        req.on("error", reject);
        req.flushHeaders();
        send = () =>
          req.end(JSON.stringify({ password: "incorrect-password" }));
      });
      return { send, result };
    });
    await new Promise((r) => setTimeout(r, 50));
    for (const c of calls) c.send();
    const statuses = await Promise.all(calls.map((c) => c.result));
    assert.ok(statuses.filter((s) => s === 401).length <= 10);
    const r = await fetch(f.base + "/api/login", {
      method: "POST",
      headers: { Origin: f.base, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "incorrect-password" }),
    });
    assert.equal(r.status, 429);
  } finally {
    await f.close();
  }
});
test("Telegram web login endpoints require admin session and CSRF without exposing credentials", async () => {
  const { TelegramLogin } = await import("../src/telegram-login.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(process.cwd(), ".test-login-api-"));
  const store = new Store(":memory:"),
    adapter = new MockAdapter(),
    worker = new Worker(store, adapter);
  const loginFlow = new TelegramLogin(
    join(dir, "auth.json"),
    async () => ({
      sendCode: async () => ({ viaApp: true }),
      signIn: async () => ({ id: "123", name: "Test" }),
      password: async () => ({ id: "123", name: "Test" }),
      session: () => "session-secret",
      close: async () => {},
    }),
    () => false,
  );
  const app = createApp({
    store,
    adapter,
    worker,
    passwordHash: hashPassword("testing-password"),
    telegramLogin: loginFlow,
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  try {
    assert.equal((await fetch(base + "/api/telegram/status")).status, 401);
    const { cookie, csrf } = await login(base);
    const body = JSON.stringify({
      phone: "+6581234567",
      apiId: 12345,
      apiHash: "0123456789abcdef0123456789abcdef",
    });
    assert.equal(
      (
        await fetch(base + "/api/telegram/start", {
          method: "POST",
          headers: { cookie, Origin: base, "Content-Type": "application/json" },
          body,
        })
      ).status,
      403,
    );
    const started = await fetch(base + "/api/telegram/start", {
      method: "POST",
      headers: {
        cookie,
        Origin: base,
        "x-csrf-token": csrf,
        "Content-Type": "application/json",
      },
      body,
    });
    assert.equal(started.status, 200);
    const view = await started.text();
    assert.ok(!view.includes("0123456789abcdef"));
    assert.match(view, /code/);
  } finally {
    await loginFlow.close();
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("batch request waiting for body must recheck concurrent Telegram login before creation", async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await login(f.base);
    f.store.settings("wallet", {
      balance: 200000,
      at: new Date().toISOString(),
    });
    const importId = f.store.saveImport([
      {
        row: 2,
        code: "AB12CD",
        quantity: 1,
        maxCost: 1700,
        note: "",
        errors: [],
      },
    ]);
    const { request } = await import("node:http");
    // Use a second server around the same test store, with a controlled login-status view.
    let pending = false;
    const fake: any = {
      status: () => ({
        phase: pending ? "code" : "idle",
        busy: pending,
        configured: true,
      }),
    };
    const app = createApp({
      store: f.store,
      adapter: f.adapter,
      worker: f.worker,
      passwordHash: hashPassword("testing-password"),
      telegramLogin: fake,
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.address() as any).port}`;
    let req: any;
    const response = new Promise<number>((resolve, reject) => {
      req = request(
        base + "/api/batches",
        {
          method: "POST",
          headers: {
            cookie,
            Origin: base,
            "x-csrf-token": csrf,
            "Content-Type": "application/json",
          },
        },
        (r) => {
          r.resume();
          r.on("end", () => resolve(r.statusCode!));
        },
      );
      req.on("error", reject);
      req.flushHeaders();
    });
    await new Promise((r) => setTimeout(r, 40));
    pending = true;
    req.end(
      JSON.stringify({ key: "slow-batch", importId, rows: [2], budget: 1700 }),
    );
    const status = await response;
    await new Promise<void>((r) => app.close(() => r()));
    assert.equal(status, 400);
    assert.equal(f.store.orders().length, 0);
  } finally {
    await f.close();
  }
});

test("single recharge needs no import, derives its budget and submits once on retries", async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await login(f.base);
    const headers = {
      cookie,
      Origin: f.base,
      "x-csrf-token": csrf,
      "Content-Type": "application/json",
    };
    const submit = (data: unknown, h = headers) =>
      fetch(f.base + "/api/single-orders", {
        method: "POST",
        headers: h,
        body: JSON.stringify(data),
      });
    assert.equal(
      (
        await fetch(f.base + "/api/single-orders", {
          method: "POST",
          headers: { Origin: f.base },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (await submit({}, { ...headers, "x-csrf-token": "wrong" })).status,
      403,
    );
    const payload = {
      key: "single-once",
      code: " ab12cd ",
      quantity: 5,
      budget: 1,
      maxCost: 1,
    };
    assert.equal(
      (await submit(payload)).status,
      400,
      "unknown balance blocks creation",
    );
    f.store.settings("wallet", { balance: 7499 });
    assert.equal(
      (await submit(payload)).status,
      400,
      "budget comes from supported package price",
    );
    f.store.settings("wallet", { balance: 200000 });
    const first = await submit(payload);
    assert.equal(first.status, 200);
    const batch = await first.json();
    assert.equal(batch.budget, 7500);
    assert.equal(f.store.orders().length, 1);
    assert.equal(f.store.orders()[0].code, "AB12CD");
    assert.equal(f.store.orders()[0].quantity, 5);
    assert.equal(f.store.orders()[0].maxCost, 7500);
    assert.equal(f.adapter.submissions, 0, "creation only queues the order");
    f.store.settings("wallet", { balance: null });
    assert.equal((await (await submit(payload)).json()).id, batch.id);
    assert.equal(f.store.orders().length, 1);
    await f.worker.tick();
    assert.equal(f.store.orders()[0].status, "succeeded");
    assert.equal(f.adapter.submissions, 1);
    f.store.settings("wallet", { balance: 200000 });
    assert.equal((await submit({ ...payload, key: "repeat" })).status, 400);
    assert.equal(
      (await submit({ ...payload, key: "repeat", allowRepeat: true })).status,
      200,
    );
    assert.equal(
      (await submit({ ...payload, key: "repeat-pending", allowRepeat: true }))
        .status,
      400,
    );
    assert.equal(
      (await submit({ ...payload, quantity: 1 })).status,
      400,
      "same key cannot change payload",
    );
  } finally {
    await f.close();
  }
});

test("single recharge rejects malformed codes and unsupported quantities without saving orders", async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await login(f.base);
    f.store.settings("wallet", { balance: 200000 });
    for (const data of [
      { code: "", quantity: 1 },
      { code: "AB12CDx", quantity: 1 },
      { code: "AB12CD", quantity: 2 },
      { code: "AB12CD", quantity: 1.5 },
      { code: "AB12CD", quantity: "5" },
      { code: 123456, quantity: 1 },
    ]) {
      const r = await fetch(f.base + "/api/single-orders", {
        method: "POST",
        headers: {
          cookie,
          Origin: f.base,
          "x-csrf-token": csrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: "invalid-single", ...data }),
      });
      assert.equal(r.status, 400);
    }
    assert.equal(f.store.orders().length, 0);
  } finally {
    await f.close();
  }
});

test("batch quantity can use spreadsheet rows or a uniform override with matching cost totals", async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await login(f.base);
    f.store.settings("wallet", { balance: 200000 });
    const importId = f.store.saveImport([
      {
        row: 2,
        code: "AB12CD",
        quantity: 1,
        maxCost: null,
        note: "",
        errors: [],
      },
      {
        row: 3,
        code: "EF34GH",
        quantity: 20,
        maxCost: 28000,
        note: "",
        errors: [],
      },
      {
        row: 4,
        code: "IJ56KL",
        quantity: 30,
        maxCost: null,
        note: "",
        errors: [],
      },
      {
        row: 5,
        code: "MN78OP",
        quantity: null,
        maxCost: null,
        note: "",
        errors: [],
      },
    ]);
    // Existing table quantities must also be overridden, not just blank rows.
    const existing = f.store.getImport(importId) as any[];
    existing.push({
      row: 6,
      code: "QR90ST",
      quantity: 10,
      maxCost: null,
      note: "",
      errors: [],
    });
    const overrideImportId = f.store.saveImport(existing);
    const submit = (data: object) =>
      fetch(f.base + "/api/batches", {
        method: "POST",
        headers: {
          cookie,
          Origin: f.base,
          "x-csrf-token": csrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ importId, ...data }),
      });
    const first = await submit({
      key: "table-quantity",
      rows: [2, 3, 4],
      quantity: null,
      maxCost: null,
      budget: 79700,
    });
    assert.equal(first.status, 200);
    const orders = f.store
      .orders()
      .sort((a, b) => a.code.localeCompare(b.code));
    assert.deepEqual(
      orders.map((o) => [o.quantity, o.maxCost]),
      [
        [1, 1700],
        [20, 28000],
        [30, 50000],
      ],
    );
    const missing = await submit({
      key: "missing-quantity",
      rows: [5],
      quantity: null,
      budget: 50000,
    });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /第 5 行.*充值量/);
    const uniform = await submit({
      key: "uniform-quantity",
      importId: overrideImportId,
      rows: [5, 6],
      quantity: 5,
      maxCost: null,
      budget: 15000,
    });
    assert.equal(uniform.status, 200);
    const order = f.store.orders().find((o) => o.code === "MN78OP")!;
    assert.equal(order.quantity, 5);
    assert.equal(order.maxCost, 7500);
    assert.equal(
      f.store.orders().find((o) => o.code === "QR90ST")!.quantity,
      5,
    );
  } finally {
    await f.close();
  }
});

test("state archives terminal batches regardless of pause and reports exact result counts", async () => {
  const f = await fixture();
  try {
    const { cookie } = await login(f.base);
    const b = f.store.createBatch(
      "archive-mixed",
      ["AB12CD", "EF34GH", "IJ56KL"].map((code) => ({
        code,
        quantity: 1,
        maxCost: 1700,
      })),
      5100,
    );
    const orders = f.store.orders();
    ["succeeded", "failed", "cancelled"].forEach((s, i) =>
      f.store.setStatus(orders[i].id, s, "test"),
    );
    f.store.pause(b.id);
    const state = await (
      await fetch(f.base + "/api/state", { headers: { cookie } })
    ).json();
    const batch = state.batches.find((v: any) => v.id === b.id);
    assert.equal(batch.finished, true);
    assert.equal(batch.canResume, false);
    assert.equal(batch.counts.succeeded, 1);
    assert.equal(batch.counts.failed, 1);
    assert.equal(batch.counts.cancelled, 1);
    assert.equal(batch.counts.total, 3);
    assert.throws(() => f.store.resume(b.id), /没有待执行订单/);
    assert.equal(f.store.orders().length, 3);
  } finally {
    await f.close();
  }
});

test("state keeps unfinished statuses visible and archives after review resolution", async () => {
  const f = await fixture();
  try {
    const { cookie } = await login(f.base);
    const statuses = [
      "queued",
      "preparing",
      "payment_submitting",
      "processing",
      "needs_review",
      "partial",
      "future_status",
    ];
    statuses.forEach((status, i) => {
      const b = f.store.createBatch(
        "visible-" + status,
        [
          {
            code: "A" + String(i).padStart(5, "0"),
            quantity: 1,
            maxCost: 1700,
          },
        ],
        1700,
      );
      const order = f.store.orders().find((o) => o.batchId === b.id)!;
      f.store.setStatus(order.id, status, "test");
      f.store.pause(b.id);
    });
    let state = await (
      await fetch(f.base + "/api/state", { headers: { cookie } })
    ).json();
    for (const b of state.batches) {
      assert.equal(b.finished, false);
      assert.equal(
        b.canResume,
        false,
        "pending payment or review anywhere blocks resume",
      );
    }
    const review = f.store.orders().find((o) => o.status === "needs_review")!;
    f.store.resolve(review.id, "not_charged");
    state = await (
      await fetch(f.base + "/api/state", { headers: { cookie } })
    ).json();
    assert.equal(
      state.batches.find((b: any) => b.id === review.batchId).finished,
      true,
    );
    const partial = f.store.orders().find((o) => o.status === "partial")!;
    assert.equal(
      state.batches.find((b: any) => b.id === partial.batchId).finished,
      false,
    );
  } finally {
    await f.close();
  }
});

test("queue stop is visible in state and resume requires authentication, CSRF and cleared blockers", async () => {
  const f = await fixture();
  try {
    f.store.haltQueue("连续3单异常，已暂停");
    const { cookie, csrf } = await login(f.base);
    const headers = { cookie, Origin: f.base, "x-csrf-token": csrf };
    assert.equal(
      (
        await fetch(f.base + "/api/queue/resume", {
          method: "POST",
          headers: { Origin: f.base },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(f.base + "/api/queue/resume", {
          method: "POST",
          headers: { cookie, Origin: f.base },
          body: "{}",
        })
      ).status,
      403,
    );
    const state = await (
      await fetch(f.base + "/api/state", { headers: { cookie } })
    ).json();
    assert.equal(state.queueControl.stopped, true);
    assert.match(state.queueControl.reason, /连续3单异常/);
    const b = f.store.createBatch(
      "blocker",
      [{ code: "AB12CD", quantity: 1, maxCost: 1700 }],
      1700,
    );
    const o = f.store.orders().find((o) => o.batchId === b.id)!;
    f.store.setStatus(o.id, "needs_review", "legacy or unmatched receipt");
    const resume = () =>
      fetch(f.base + "/api/queue/resume", {
        method: "POST",
        headers,
        body: "{}",
      });
    assert.equal((await resume()).status, 400);
    f.store.resolve(o.id, "not_charged");
    assert.equal((await resume()).status, 200);
    assert.equal(f.store.queueControl().stopped, false);
    assert.equal(f.store.settings("queueStreak"), 0);
  } finally {
    await f.close();
  }
});

test("manual receipt selection persists ambiguous-message ownership before queue resume", async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await login(f.base);
    const headers = {
      cookie,
      Origin: f.base,
      "x-csrf-token": csrf,
      "Content-Type": "application/json",
    };
    const text =
      "TOKEN DELIVERED SUCCESSFULLY!\nTokens Credited: +1 Billion Tokens (1B)\nInvite Code: AB12CD\nCharged from Main Balance: Rp 1700\nMain Balance Remaining (Universal): IDR 10000";
    const quote = {
      code: "AB12CD",
      quantity: 1,
      cost: 1700,
      ref: JSON.stringify({ id: 11, startMaxId: 10, maxId: 11 }),
    };
    f.store.createBatch(
      "first",
      [{ code: "AB12CD", quantity: 1, maxCost: 1700 }],
      1700,
    );
    const first = f.store.claim()!;
    f.store.beginPayment(first.id, quote);
    const receipt = {
      code: "AB12CD",
      quantity: 1,
      cost: 1700,
      balance: 10000,
      raw: text,
    };
    f.store.setStatus(first.id, "succeeded", "first", { receipt });
    f.store.createBatch(
      "repeat",
      [{ code: "AB12CD", quantity: 1, maxCost: 1700 }],
      1700,
      true,
    );
    const second = f.store.claim()!;
    f.store.beginPayment(second.id, quote);
    f.store.setStatus(second.id, "needs_review", "timeout");
    f.store.isolateReview(second.id);
    f.store.observeReceipt({ ...receipt, messageId: 22 });
    const detail = await (
      await fetch(f.base + `/api/orders/${second.id}`, { headers: { cookie } })
    ).json();
    assert.equal(detail.pendingReceipts[0].messageId, 22);
    const settle = (messageId: number) =>
      fetch(f.base + `/api/orders/${second.id}/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          resolution: "record_receipt",
          receipt: text,
          messageId,
        }),
      });
    assert.equal((await settle(999)).status, 400);
    assert.equal((await settle(22)).status, 200);
    assert.equal(f.store.settings("receiptMessage:22").orderId, second.id);
    assert.equal(f.store.pendingReceipts("AB12CD").length, 0);
    const resume = await fetch(f.base + "/api/queue/resume", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(resume.status, 200);
    assert.equal(f.store.observeReceipt({ ...receipt, messageId: 22 }), true);
    assert.equal(f.store.queueControl().stopped, false);
  } finally {
    await f.close();
  }
});
