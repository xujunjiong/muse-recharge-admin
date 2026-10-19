import test from "node:test";
import assert from "node:assert/strict";
import {
  TelegramAdapter,
  type Snapshot,
  type Transport,
} from "../src/adapters/telegram.js";

// 真实故障（2026-10-19）：机器人 06:20:03 就发了回执，
// 适配器 06:20:09 才点完"Yes, Process Token"，旧 result()
// 只看报价之后的新消息，把这条早期回执漏掉，空等 3 分钟超时。
test("result accepts a receipt that arrived before payment submission", async () => {
  const receiptText =
    "✅ TOKEN DELIVERED SUCCESSFULLY! 🥳\n" +
    "🎉 Tokens Credited: +30 Billion Tokens (30B)\n" +
    "🏷️ Invite Code: AB12CD\n" +
    "💳 Charged from Main Balance: Rp 40.500 / $2.26\n" +
    "💰 Main Balance Remaining (Universal): IDR 459.500";
  const t: Transport = {
    read: async () => [{ id: 22, text: receiptText, buttons: [] }] as Snapshot[],
    send: async () => {},
    close: async () => {},
  };
  const a = new TelegramAdapter(t, 5000, 1);
  const q = {
    code: "AB12CD",
    quantity: 30,
    cost: 40500,
    raw: "MUSEAI TOKEN DELIVERY CONFIRMATION",
    ref: JSON.stringify({
      id: 20,
      text: "MUSEAI TOKEN DELIVERY CONFIRMATION",
      maxId: 25,
      startMaxId: 10,
    }),
  };
  const r = await a.result(q as any);
  assert.equal(r.code, "AB12CD");
  assert.equal(r.quantity, 30);
  assert.equal(r.cost, 40500);
  assert.equal(r.balance, 459500);
});
