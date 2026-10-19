import test from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter, type Snapshot } from "../src/adapters/telegram.js";
function text(code: string) {
  return `TOKEN DELIVERED SUCCESSFULLY!\nTokens Credited: +1 Billion Tokens (1B)\nInvite Code: ${code}\nCharged from Main Balance: Rp 1700\nMain Balance Remaining (Universal): IDR 10000`;
}
const quote = {
  code: "EF34GH",
  quantity: 1,
  cost: 1700,
  ref: JSON.stringify({ id: 20, text: "confirm", startMaxId: 19, maxId: 20 }),
};

test("a known foreign late receipt is routed away while waiting for the current order", async () => {
  let reads = 0;
  const seen: string[] = [];
  const adapter = new TelegramAdapter(
    {
      read: async () => {
        reads++;
        const snapshots: Snapshot[] = [
          { id: 22, text: text("AB12CD"), buttons: [] },
        ];
        if (reads > 1)
          snapshots.push({ id: 23, text: text("EF34GH"), buttons: [] });
        return snapshots;
      },
      send: async () => {},
      close: async () => {},
    },
    100,
    1,
  );
  (adapter as any).onReceipt = (r: any) => {
    seen.push(r.code);
    return ["AB12CD", "EF34GH"].includes(r.code);
  };
  const result = await adapter.result(quote);
  assert.equal(result.code, "EF34GH");
  assert.ok(seen.includes("AB12CD"));
});

test("an unowned foreign receipt and an expired session stop instead of being silently retried", async () => {
  const foreign = new TelegramAdapter(
    {
      read: async () => [{ id: 22, text: text("AB12CD"), buttons: [] }],
      send: async () => {},
      close: async () => {},
    },
    100,
    1,
  );
  await assert.rejects(foreign.result(quote), /回执.*归属|回执.*不匹配/);
  let reads = 0;
  const expired = new TelegramAdapter(
    {
      read: async () => {
        reads++;
        throw Error("SESSION_REVOKED");
      },
      send: async () => {},
      close: async () => {},
    },
    30,
    1,
  );
  await assert.rejects(expired.result(quote), /SESSION_REVOKED/);
  assert.equal(reads, 1);
});

test("a receipt already bound to an earlier payment cannot satisfy a repeat target", async () => {
  let reads = 0;
  const adapter = new TelegramAdapter(
    {
      read: async () => {
        reads++;
        return reads === 1
          ? [{ id: 22, text: text("EF34GH"), buttons: [] }]
          : [{ id: 23, text: text("EF34GH"), buttons: [] }];
      },
      send: async () => {},
      close: async () => {},
    },
    100,
    1,
  );
  adapter.onReceipt = () => true;
  adapter.receiptOwner = (id) => (id === 22 ? "old-order" : "current-order");
  const result = await adapter.result({ ...quote, orderId: "current-order" });
  assert.equal(result.messageId, 23);
});
