import test from "node:test";
import assert from "node:assert/strict";
import {
  TelegramAdapter,
  type Snapshot,
  type Transport,
} from "../src/adapters/telegram.js";

// 真实故障（2026-10-19）：付款已提交、等回执期间 Telegram 请求闪断一次
// （"Request was unsuccessful 1 time(s)"），旧逻辑直接把订单判为异常。
// 现在应该继续等，而不是立刻失败。
test("result survives transient read failures while waiting", async () => {
  const receiptText =
    "✅ TOKEN DELIVERED SUCCESSFULLY! 🥳\n" +
    "🎉 Tokens Credited: +30 Billion Tokens (30B)\n" +
    "🏷️ Invite Code: AB12CD\n" +
    "💳 Charged from Main Balance: Rp 40.500 / $2.26\n" +
    "💰 Main Balance Remaining (Universal): IDR 459.500";
  let calls = 0;
  const t: Transport = {
    read: async () => {
      calls++;
      if (calls === 1) throw Error("Request was unsuccessful 1 time(s)");
      return [{ id: 22, text: receiptText, buttons: [] }] as Snapshot[];
    },
    send: async () => {},
    close: async () => {},
  };
  const a = new TelegramAdapter(t, 5000, 1);
  const q = {
    code: "AB12CD",
    quantity: 30,
    cost: 40500,
    raw: "confirm",
    ref: JSON.stringify({
      id: 20,
      text: "confirm",
      maxId: 25,
      startMaxId: 10,
    }),
  };
  const r = await a.result(q as any);
  assert.equal(r.code, "AB12CD");
  assert.equal(r.quantity, 30);
  assert.ok(calls >= 2);
});
