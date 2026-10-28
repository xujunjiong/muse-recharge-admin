import test from "node:test";
import assert from "node:assert/strict";
import { createApp, hashPassword } from "../src/app.js";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";
import { MockAdapter } from "../src/adapters/mock.js";

async function fixture() {
  const store = new Store(":memory:"),
    adapter = new MockAdapter(),
    worker = new Worker(store, adapter);
  const server = createApp({
    store,
    adapter,
    worker,
    passwordHash: hashPassword("testing-password"),
    singlePasswordHash: hashPassword("single-password"),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    store,
    base,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}
async function login(base: string, password: string) {
  const r = await fetch(base + "/api/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const j = await r.json();
  return { cookie, csrf: j.csrf, role: j.role };
}

test("single login role and admin route rejection", async () => {
  const f = await fixture();
  try {
    const admin = await login(f.base, "testing-password");
    assert.equal(admin.role, "admin");
    const single = await login(f.base, "single-password");
    assert.equal(single.role, "single");
    let r = await fetch(f.base + "/api/single/orders", {
      headers: { cookie: single.cookie },
    });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).orders, []);
    r = await fetch(f.base + "/api/state", {
      headers: { cookie: single.cookie },
    });
    assert.equal(r.status, 403);
    r = await fetch(f.base + "/api/batches", {
      method: "POST",
      headers: {
        cookie: single.cookie,
        Origin: f.base,
        "Content-Type": "application/json",
        "x-csrf-token": single.csrf,
      },
      body: "{}",
    });
    assert.equal(r.status, 403);
    r = await fetch(f.base + "/api/export", {
      headers: { cookie: single.cookie },
    });
    assert.equal(r.status, 403);
    r = await fetch(f.base + "/api/state", {
      headers: { cookie: admin.cookie },
    });
    assert.equal(r.status, 200);
  } finally {
    await f.close();
  }
});

test("single page only accepts single sessions", async () => {
  const f = await fixture();
  try {
    const admin = await login(f.base, "testing-password");
    assert.equal(admin.role, "admin");
    let r = await fetch(f.base + "/api/session", {
      headers: { cookie: admin.cookie },
    });
    assert.equal((await r.json()).role, "admin");
    const single = await login(f.base, "single-password");
    r = await fetch(f.base + "/api/session", {
      headers: { cookie: single.cookie },
    });
    assert.equal((await r.json()).role, "single");
    r = await fetch(f.base + "/api/single/orders", {
      headers: { cookie: admin.cookie },
    });
    assert.equal(r.status, 403);
    r = await fetch(f.base + "/api/single/order", {
      method: "POST",
      headers: {
        cookie: admin.cookie,
        Origin: f.base,
        "Content-Type": "application/json",
        "x-csrf-token": admin.csrf,
      },
      body: JSON.stringify({ code: "AB12CD" }),
    });
    assert.equal(r.status, 403);
    r = await fetch(f.base + "/api/single/orders", {
      headers: { cookie: single.cookie },
    });
    assert.equal(r.status, 200);
  } finally {
    await f.close();
  }
});

test("single order creation, priority claim, history isolation", async () => {
  const f = await fixture();
  try {
    const single = await login(f.base, "single-password");
    const headers = {
      cookie: single.cookie,
      Origin: f.base,
      "x-csrf-token": single.csrf,
      "Content-Type": "application/json",
    };
    let r = await fetch(f.base + "/api/single/order", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "AB12" }),
    });
    assert.equal(r.status, 400);
    r = await fetch(f.base + "/api/single/order", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "ab12cd" }),
    });
    assert.equal(r.status, 200);
    const created = await r.json();
    assert.equal(created.code, "AB12CD");
    r = await fetch(f.base + "/api/single/order", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "AB12CD" }),
    });
    assert.equal(r.status, 400);
    r = await fetch(f.base + "/api/single/orders", {
      headers: { cookie: single.cookie },
    });
    const orders = (await r.json()).orders;
    assert.equal(orders.length, 1);
    assert.equal(orders[0].code, "AB12CD");
    assert.equal(orders[0].quantity, 30);
    assert.equal(orders[0].maxCost, 50000);
    assert.equal(orders[0].status, "queued");
    f.store.createBatch(
      "batch-key",
      [{ code: "ZZ99XX", quantity: 1, maxCost: 1700, note: "" }],
      1700,
    );
    const claimed = f.store.claim();
    assert.equal(claimed!.code, "AB12CD");
    r = await fetch(f.base + "/api/single/orders", {
      headers: { cookie: single.cookie },
    });
    assert.deepEqual(
      (await r.json()).orders.map((o: any) => o.code),
      ["AB12CD"],
    );
  } finally {
    await f.close();
  }
});
