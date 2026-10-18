import test from "node:test";
import assert from "node:assert/strict";
import {
  TelegramAdapter,
  type Snapshot,
  type Transport,
  isFreshResult,
} from "../src/adapters/telegram.js";
test("result association accepts edited current message or newer message only", () => {
  assert.equal(
    isFreshResult({ id: 10, text: "old" } as Snapshot, {
      id: 10,
      text: "old",
      maxId: 20,
    }),
    false,
  );
  assert.equal(
    isFreshResult({ id: 9, text: "edited historical success" } as Snapshot, {
      id: 10,
      text: "old",
      maxId: 20,
    }),
    false,
  );
  assert.equal(
    isFreshResult({ id: 10, text: "new success" } as Snapshot, {
      id: 10,
      text: "old",
      maxId: 20,
    }),
    true,
  );
  assert.equal(
    isFreshResult({ id: 21, text: "new success" } as Snapshot, {
      id: 10,
      text: "old",
      maxId: 20,
    }),
    true,
  );
});
test("adapter navigates current callbacks and sends one explicit payment", async () => {
  let stage = 0,
    payments = 0,
    seq = 0;
  const make = (text: string, next: number) => ({
    text,
    callback: true,
    click: async () => {
      stage = next;
    },
  });
  const quote =
    "MUSEAI TOKEN DELIVERY CONFIRMATION\nInvite Code: AB12CD\nFill Target: 1B Tokens\nTotal Main Balance Cost: Rp 1.700 / $0.10\nMain Balance: IDR 10000";
  const t: Transport = {
    read: async () => [
      {
        id: 10 + seq,
        text: [
          "Welcome to Satu Digital",
          "Automatic MuseAI Token Filling",
          "SEND YOUR MUSE ACCOUNT CODE",
          "Muse Code Detected: AB12CD",
          "Muse Code: AB12CD\nChoose a Quota Package",
          quote,
          "TOKEN DELIVERED SUCCESSFULLY!\nTokens Credited: +1 Billion Tokens (1B)\nInvite Code: AB12CD\nCharged from Main Balance: Rp 1.700\nMain Balance Remaining (Universal): IDR 10000",
        ][stage],
        buttons: [
          [make("MuseAI Token (From Rp 1.300)", 1)],
          [make("Enter Muse Code", 2)],
          [],
          [make("Want More Quota? (5B - 30B Pack)", 4)],
          [make("1B — Rp 1.700 / $0.10 (Retail)", 5)],
          [
            {
              text: "Yes, Process Token",
              callback: true,
              click: async () => {
                payments++;
                stage = 6;
              },
            },
          ],
          [],
        ][stage],
      },
    ],
    send: async (text) => {
      if (text === "/start") {
        stage = 0;
        seq++;
      } else {
        assert.equal(text, "AB12CD");
        stage = 3;
      }
    },
    close: async () => {},
  };
  const a = new TelegramAdapter(t, 1000, 1);
  const q = await a.prepare({ code: "AB12CD", quantity: 1, maxCost: 1700 });
  assert.equal(q.cost, 1700);
  await assert.rejects(
    a.submit(q, () => false),
    /失效/,
  );
  assert.equal(payments, 0);
  await a.submit(q);
  await assert.rejects(a.submit(q), /重复/);
  const r = await a.result(q);
  assert.equal(r.code, "AB12CD");
  assert.equal(payments, 1);
});
test("GramJS options use exactly one request attempt, not zero attempts or retries", async () => {
  const { TELEGRAM_OPTIONS } = await import("../src/adapters/telegram.js");
  assert.equal(TELEGRAM_OPTIONS.requestRetries, 1);
});
test("preparation rejects an edited historical confirmation outside current menu", async () => {
  let changed = false,
    clicked = 0;
  const quote =
    "MUSEAI TOKEN DELIVERY CONFIRMATION\nInvite Code: AB12CD\nFill Target: 1B Tokens\nTotal Main Balance Cost: Rp 1.700";
  const transport: Transport = {
    read: async () => [
      {
        id: 10,
        text: changed ? quote : "old",
        buttons: [
          {
            text: "Yes, Process Token",
            callback: true,
            click: async () => {
              clicked++;
            },
          },
        ],
      },
      { id: 20, text: "current menu", buttons: [] },
    ],
    send: async () => {},
    close: async () => {},
  };
  const a = new TelegramAdapter(transport, 10, 1);
  await assert.rejects(
    a.action(
      async () => {
        changed = true;
      },
      (m) => m.text.includes("CONFIRMATION"),
      20,
    ),
    /超时/,
  );
  assert.equal(clicked, 0);
});
