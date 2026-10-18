import test from "node:test";
import assert from "node:assert/strict";
import { parseConfirmation, parseReceipt, parseIdr } from "../src/receipts.js";
test("parses only final delivery receipt and exact quantities", () => {
  const s =
    "TOKEN DELIVERED SUCCESSFULLY!\nTokens Credited: +1 Billion Tokens (1B)\nInvite Code: AB12CD\nCharged from Main Balance: Rp 1.700 / $0.10\nMain Balance Remaining (Universal): IDR 166.650";
  assert.deepEqual(parseReceipt(s), {
    code: "AB12CD",
    quantity: 1,
    cost: 1700,
    balance: 166650,
    raw: s,
  });
  assert.equal(parseReceipt("FILLING TOKENS AB12CD Target: 1B"), null);
  assert.equal(
    parseReceipt(s.replace("Invite Code: AB12CD", "Invite Code: ???")),
    null,
  );
});
test("confirmation requires explicit target and total cost", () => {
  assert.deepEqual(
    parseConfirmation(
      "MUSEAI TOKEN DELIVERY CONFIRMATION\nInvite Code: AB12CD\nFill Target: 1B Tokens\nTotal Main Balance Cost: Rp 1.700 / $0.10",
    ),
    { code: "AB12CD", quantity: 1, cost: 1700 },
  );
  assert.equal(parseConfirmation("Rate: Rp 1.700 / B"), null);
  assert.equal(parseIdr("1.700"), 1700);
  assert.equal(parseIdr("1,700"), 1700);
  assert.throws(() => parseIdr("1.70"));
});
