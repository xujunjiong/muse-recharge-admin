import { Store } from "./store.js";
import type { BotAdapter } from "./types.js";
export class Worker {
  busy = false;
  maintenance = false;
  timer?: ReturnType<typeof setInterval>;
  heartbeat?: ReturnType<typeof setInterval>;
  constructor(
    public store: Store,
    public adapter: BotAdapter,
  ) {
    if (!store.acquireWorker()) throw Error("已有执行器运行，不能重复启动");
  }
  start() {
    this.store.recover();
    this.heartbeat = setInterval(() => {
      if (!this.store.heartbeat()) this.stop();
    }, 5000);
    this.timer = setInterval(() => void this.tick(), 1000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
  async tick() {
    if (this.busy || this.maintenance || !this.store.ownsWorker()) return;
    this.busy = true;
    try {
      const o = this.store.claim();
      if (!o) return;
      try {
        const q = await this.adapter.prepare(o);
        if (!this.store.beginPayment(o.id, q)) return;
        await this.adapter.submit(
          q,
          () =>
            this.store.ownsWorker() &&
            this.store.order(o.id).status === "payment_submitting",
        );
        if (!this.store.ownsWorker()) return;
        this.store.setStatus(
          o.id,
          "processing",
          "已提交付款，等待机器人最终回执",
        );
        const r = await this.adapter.result(q);
        if (
          !this.store.ownsWorker() ||
          this.store.order(o.id).status !== "processing"
        )
          return;
        if (
          r.code !== o.code ||
          !Number.isFinite(r.quantity) ||
          r.quantity <= 0 ||
          r.quantity > o.quantity ||
          !Number.isSafeInteger(r.cost) ||
          r.cost < 0 ||
          r.cost > o.maxCost ||
          (r.cost !== q.cost && r.quantity === o.quantity)
        ) {
          throw Error("机器人回执与订单或报价不匹配");
        }
        this.store.transaction(() => {
          this.store.setStatus(
            o.id,
            r.quantity === o.quantity ? "succeeded" : "partial",
            r.quantity === o.quantity
              ? "机器人最终回执：交付成功"
              : "部分交付，未自动补单",
            { receipt: r },
          );
          this.store.settings("wallet", {
            balance: r.balance,
            at: new Date().toISOString(),
          });
          if (r.quantity !== o.quantity)
            this.store.pause(o.batchId, "部分交付，请核对后继续");
        });
      } catch (e) {
        if (!this.store.ownsWorker()) return;
        const current = this.store.order(o.id);
        if (current.status === "cancelled") return;
        this.store.transaction(() => {
          this.store.setStatus(
            o.id,
            "needs_review",
            (e as Error).message.slice(0, 400),
          );
          this.store.pause(o.batchId, "异常或付款结果不明，需核查");
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
