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
