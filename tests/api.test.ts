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
