import type { BotAdapter, InputOrder, Quote, Receipt } from "../types.js";
export class MockAdapter implements BotAdapter {
  mode = "mock" as const;
  submissions = 0;
  wallet = 200000;
  scenario:
    "success" | "timeout" | "price" | "wrongCode" | "partial" | "wrongReceipt" =
    "success";
  onPrepare?: () => void;
  async balance() {
    return this.wallet;
  }
  async prepare(o: InputOrder): Promise<Quote> {
    this.onPrepare?.();
    return {
      code: this.scenario === "wrongCode" ? "ZZ99ZZ" : o.code,
      quantity: o.quantity,
      cost:
        this.scenario === "price"
          ? o.maxCost + 1
          : (
              {
                1: 1700,
                5: 7500,
                10: 14000,
                15: 21000,
                20: 27000,
                30: 39000,
              } as Record<number, number>
            )[o.quantity],
      ref: "mock",
    };
  }
  async submit(q: Quote, canSubmit?: () => boolean) {
    if (canSubmit && !canSubmit()) throw Error("执行锁已失效，未付款");
    this.submissions++;
    this.wallet -= q.cost;
  }
  async result(q: Quote): Promise<Receipt> {
    if (this.scenario === "timeout") throw Error("模拟：付款后等待回执超时");
    await new Promise((r) => setTimeout(r, 100));
    return {
      code: this.scenario === "wrongReceipt" ? "ZZ99ZZ" : q.code,
      quantity: this.scenario === "partial" ? 1 : q.quantity,
      cost: q.cost,
      balance: this.wallet,
      raw: `[SIMULATION ONLY]\nTOKEN DELIVERED SUCCESSFULLY!\nTokens Credited: +${q.quantity} Billion Tokens (${q.quantity}B)\nInvite Code: ${q.code}\nCharged from Main Balance: Rp ${q.cost}\nMain Balance Remaining (Universal): IDR ${this.wallet}`,
    };
  }
}
