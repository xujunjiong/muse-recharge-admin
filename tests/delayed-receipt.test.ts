import test from "node:test";
import assert from "node:assert/strict";
import {
  TelegramAdapter,
  type Snapshot,
  type Transport,
} from "../src/adapters/telegram.js";

// 真实故障（2026-10-19 F0L95J）：付款提交后机器人回复
// "⏳ Token Delivery Temporarily Delayed / Our system is under periodic maintenance"。
// 这种情况下不会再有回执，应该立刻转人工核查并给出明确原因，
// 而不是空等 3 分钟报超时。
test("result reports maintenance delay clearly instead of timing out", async () => {
  const delayedText =
    "⏳ Token Delivery Temporarily Delayed\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "Our system is under periodic maintenance. Delivery will resume shortly.";
  const t: Transport = {
    read: async () => [{ id: 22, text: delayedText, buttons: [] }] as Snapshot[],
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
      maxId: 21,
      startMaxId: 10,
    }),
  };
  await assert.rejects(a.result(q as any), /系统维护中，交付延迟/);
});
