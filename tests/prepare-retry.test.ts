import test from "node:test";
import assert from "node:assert/strict";
import {
  isTransientNetworkError,
  prepareWithRetry,
} from "../src/worker.js";
import type { BotAdapter, InputOrder, Quote } from "../src/types.js";

const order = { code: "AB12CD", quantity: 30, maxCost: 42000 } as InputOrder;
const quote = { code: "AB12CD", quantity: 30, cost: 40500 } as Quote;

function fakeAdapter(failures: unknown[]): BotAdapter {
  let n = 0;
  return {
    prepare: async () => {
      if (n < failures.length) throw failures[n++];
      n++;
      return quote;
    },
  } as unknown as BotAdapter;
}

test("isTransientNetworkError identifies GramJS blips", () => {
  assert.equal(
    isTransientNetworkError(Error("Request was unsuccessful 1 time(s)")),
    true,
  );
  assert.equal(isTransientNetworkError(Error("socket hang up")), true);
  assert.equal(
    isTransientNetworkError(Error("机器人菜单不匹配或按钮不唯一，已停止")),
    false,
  );
  assert.equal(
    isTransientNetworkError(Error("确认页的邀请码、数量或金额不匹配")),
    false,
  );
});

test("prepareWithRetry retries transient failures then succeeds", async () => {
  const a = fakeAdapter([
    Error("Request was unsuccessful 1 time(s)"),
    Error("Request was unsuccessful 1 time(s)"),
  ]);
  const q = await prepareWithRetry(a, order, 3);
  assert.equal(q, quote);
});

test("prepareWithRetry gives up after maxAttempts", async () => {
  const a = fakeAdapter([
    Error("Request was unsuccessful 1 time(s)"),
    Error("Request was unsuccessful 1 time(s)"),
    Error("Request was unsuccessful 1 time(s)"),
  ]);
  await assert.rejects(prepareWithRetry(a, order, 2), /unsuccessful/);
});

test("prepareWithRetry does not retry logic errors", async () => {
  let calls = 0;
  const a = {
    prepare: async () => {
      calls++;
      throw Error("机器人菜单不匹配或按钮不唯一，已停止");
    },
  } as unknown as BotAdapter;
  await assert.rejects(prepareWithRetry(a, order, 3), /菜单不匹配/);
  assert.equal(calls, 1);
});
