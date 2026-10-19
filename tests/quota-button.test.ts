import test from "node:test";
import assert from "node:assert/strict";
import {
  TelegramAdapter,
  stripButtonDecor,
  type Snapshot,
  type Transport,
} from "../src/adapters/telegram.js";

test("quota button matching tolerates emoji prefix and FULL suffix", () => {
  assert.equal(
    stripButtonDecor("🔥 30B FULL — Rp 40.500 / $2.26 (BEST VALUE)"),
    "30B FULL — Rp 40.500 / $2.26 (BEST VALUE)",
  );
  assert.equal(
    stripButtonDecor("1B — Rp 1.700 / $0.10 (Retail)"),
    "1B — Rp 1.700 / $0.10 (Retail)",
  );
  assert.equal(stripButtonDecor("❌ Cancel"), "Cancel");
  // 真实机器人菜单（2026-10-19 实测）："Custom Amount (1B - 30B)" 里也含
  // "1B"/"30B"，必须锚定开头，不能宽松包含匹配。
  const buttons = [
    "🔥 30B FULL — Rp 40.500 / $2.26 (BEST VALUE)",
    "20B — Rp 26.000 / $1.45",
    "15B — Rp 21.000 / $1.17",
    "10B — Rp 14.000 / $0.78",
    "5B — Rp 7.500 / $0.42",
    "1B — Rp 1.700 / $0.10 (Retail)",
    "✏️ Custom Amount (1B - 30B)",
    "⬅️ Back to Free Balance",
    "❌ Cancel",
  ].map((text) => ({ text, callback: true, click: async () => {} }));
  const m = { id: 1, text: "quota menu", buttons } as Snapshot;
  const noop: Transport = {
    read: async () => [],
    send: async () => {},
    close: async () => {},
  };
  const a = new TelegramAdapter(noop, 1000, 1);
  assert.equal(
    a.quotaButton(m, 30).text,
    "🔥 30B FULL — Rp 40.500 / $2.26 (BEST VALUE)",
  );
  assert.equal(a.quotaButton(m, 1).text, "1B — Rp 1.700 / $0.10 (Retail)");
  assert.equal(a.quotaButton(m, 15).text, "15B — Rp 21.000 / $1.17");
  assert.equal(a.quotaButton(m, 20).text, "20B — Rp 26.000 / $1.45");
  assert.throws(() => a.quotaButton(m, 2), /不匹配/);
});
