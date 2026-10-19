import { Store } from "./store.js";
import type { BotAdapter, InputOrder, Quote } from "./types.js";

/**
 * 准备阶段（进菜单、填邀请码、选配额、读确认页）不触碰资金，
 * 瞬时网络抖动可安全重试，不必每次都进人工核查、暂停整批。
 * 注意：submit() 一旦开始就涉及资金，绝不自动重试。
 */
export { isTransientNetworkError } from "./execution-errors.js";
import {
  classifyFailure,
  errorMessage,
  isTransientNetworkError,
} from "./execution-errors.js";
import { receiptMatches } from "./receipt-matching.js";

export async function prepareWithRetry(
  adapter: BotAdapter,
  order: InputOrder,
  maxAttempts = 3,
): Promise<Quote> {
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await adapter.prepare(order);
    } catch (e) {
      last = e;
      if (!isTransientNetworkError(e) || attempt >= maxAttempts) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw last;
}
export class Worker {
  busy = false;
  private nextReceiptPoll = 0;
  maintenance = false;
  timer?: ReturnType<typeof setInterval>;
  heartbeat?: ReturnType<typeof setInterval>;
  constructor(
    public store: Store,
    public adapter: BotAdapter,
  ) {
    if (!store.acquireWorker()) throw Error("已有执行器运行，不能重复启动");
    adapter.onReceipt = (receipt) =>
      store.ownsWorker() && store.observeReceipt(receipt);
    adapter.receiptOwner = (id) =>
      store.settings("receiptMessage:" + id)?.orderId;
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
    if (
      this.busy ||
      this.maintenance ||
      this.adapter.ready === false ||
      !this.store.ownsWorker()
    )
      return;
    this.busy = true;
    try {
      if (
        this.adapter.pollReceipts &&
        Date.now() >= this.nextReceiptPoll &&
        this.store
          .orders()
          .some(
            (o) =>
              o.status === "needs_review" &&
              this.store.settings("isolatedReview:" + o.id) === true,
          )
      ) {
        this.nextReceiptPoll = Date.now() + 15000;
        try {
          await this.adapter.pollReceipts();
        } catch (e) {
          if (!isTransientNetworkError(e))
            this.store.haltQueue(errorMessage(e));
        }
      }
      const o = this.store.claim();
      if (!o) return;
      try {
        const q = {
          ...(await prepareWithRetry(this.adapter, o)),
          orderId: o.id,
        };
        if (!this.store.beginPayment(o.id, q)) return;
        let submissionMessage = "已提交付款，等待机器人最终回执";
        try {
          await this.adapter.submit(
            q,
            () =>
              this.store.ownsWorker() &&
              !this.store.queueControl().stopped &&
              this.store.order(o.id).status === "payment_submitting",
          );
        } catch (e) {
          if (!isTransientNetworkError(e)) throw e;
          submissionMessage = "付款提交时网络闪断，结果不明，等待回执确认";
        }
        if (!this.store.ownsWorker()) return;
        this.store.setStatus(o.id, "processing", submissionMessage);
        const r = await this.adapter.result(q);
        if (
          !this.store.ownsWorker() ||
          this.store.order(o.id).status !== "processing"
        )
          return;
        if (!receiptMatches(o, q, r))
          throw Error("机器人回执与订单或报价不匹配");
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
          if (r.messageId)
            this.store.settings("receiptMessage:" + r.messageId, {
              orderId: o.id,
            });
          this.store.recordOutcome(o.batchId, r.quantity === o.quantity);
          if (r.quantity !== o.quantity)
            this.store.pause(o.batchId, "部分交付，请核对后继续");
        });
      } catch (e) {
        if (!this.store.ownsWorker()) return;
        const current = this.store.order(o.id);
        if (current.status === "cancelled") return;
        const paymentStarted = ["payment_submitting", "processing"].includes(
          current.status,
        );
        const kind = classifyFailure(e, paymentStarted);
        this.store.transaction(() => {
          this.store.setStatus(
            o.id,
            paymentStarted ? "needs_review" : "failed",
            errorMessage(e).slice(0, 400),
          );
          if (paymentStarted && kind === "uncertain")
            this.store.isolateReview(o.id);
          if (paymentStarted)
            this.store.settings("wallet", {
              balance: null,
              at: new Date().toISOString(),
              error: "付款结果待核查，后续付款仍核对机器人实时余额",
            });
          if (kind === "systemic")
            this.store.haltQueue(
              "系统性异常：" + errorMessage(e).slice(0, 300),
            );
          this.store.recordOutcome(o.batchId, false);
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
