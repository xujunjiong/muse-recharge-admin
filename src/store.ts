import { DatabaseSync } from "node:sqlite";
import { ExecutionError } from "./execution-errors.js";
import { receiptMatches } from "./receipt-matching.js";
import { PACKAGE_PRICES } from "./pricing.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  QUANTITIES,
  positiveInt,
  type Batch,
  type InputOrder,
  type Order,
  type Quote,
  type Receipt,
} from "./types.js";
export class Store {
  db: DatabaseSync;
  owner: string = randomUUID();
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, requestKey TEXT UNIQUE, payload TEXT, budget INTEGER, paused INTEGER DEFAULT 0, reason TEXT DEFAULT '', createdAt TEXT);
 CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,batchId TEXT REFERENCES batches(id),code TEXT,quantity INTEGER,maxCost INTEGER,note TEXT,status TEXT,actualQuantity REAL,actualCost INTEGER,message TEXT DEFAULT '',quote TEXT,receipt TEXT,createdAt TEXT,updatedAt TEXT,priority INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT 'batch',account TEXT NOT NULL DEFAULT 'main',UNIQUE(batchId,code));
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,orderId TEXT,status TEXT,message TEXT,createdAt TEXT);
 CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,rows TEXT,createdAt TEXT);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,csrf TEXT,expires INTEGER,role TEXT NOT NULL DEFAULT 'admin');
 CREATE TABLE IF NOT EXISTS worker_lock(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,expires INTEGER,pid INTEGER);`);
    if (
      !(this.db.prepare("PRAGMA table_info(worker_lock)").all() as any[]).some(
        (c) => c.name === "pid",
      )
    )
      this.db.exec("ALTER TABLE worker_lock ADD COLUMN pid INTEGER");
    const orderCols = (
      this.db.prepare("PRAGMA table_info(orders)").all() as any[]
    ).map((c) => c.name);
    if (!orderCols.includes("priority"))
      this.db.exec(
        "ALTER TABLE orders ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
      );
    if (!orderCols.includes("source"))
      this.db.exec(
        "ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'batch'",
      );
    if (!orderCols.includes("account"))
      this.db.exec(
        "ALTER TABLE orders ADD COLUMN account TEXT NOT NULL DEFAULT 'main'",
      );
    if (
      !(this.db.prepare("PRAGMA table_info(sessions)").all() as any[]).some(
        (c) => c.name === "role",
      )
    )
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'",
      );
  }
  transaction<T>(f: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = f();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  acquireWorker() {
    return this.transaction(() => {
      const l = this.db
        .prepare("SELECT * FROM worker_lock WHERE id=1")
        .get() as any;
      if (l && l.owner !== this.owner) {
        let alive = true;
        if (!l.pid) return false;
        try {
          process.kill(l.pid, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
        }
        if (alive) return false;
      }
      this.db
        .prepare(
          "INSERT OR REPLACE INTO worker_lock(id,owner,expires,pid) VALUES(1,?,?,?)",
        )
        .run(this.owner, Date.now() + 30000, process.pid);
      return true;
    });
  }
  ownsWorker() {
    const l = this.db
      .prepare("SELECT * FROM worker_lock WHERE id=1")
      .get() as any;
    return !!l && l.owner === this.owner && l.expires > Date.now();
  }
  heartbeat() {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE worker_lock SET expires=? WHERE id=1 AND owner=? AND expires>?",
          )
          .run(Date.now() + 30000, this.owner, Date.now()).changes,
      ) === 1
    );
  }
  enforceMode(mode: string) {
    const existing = this.settings("databaseMode");
    if (existing && existing !== mode)
      throw Error("数据库模式不匹配，请为模拟和真实模式使用独立数据库");
    this.settings("databaseMode", mode);
  }
  settings(key: string, value?: unknown): any {
    if (value !== undefined)
      this.db
        .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
        .run(key, JSON.stringify(value));
    const r = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as any;
    return r ? JSON.parse(r.value) : null;
  }
  saveImport(rows: unknown) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO imports VALUES(?,?,?)")
      .run(id, JSON.stringify(rows), new Date().toISOString());
    return id;
  }
  getImport(id: string) {
    const r = this.db
      .prepare("SELECT rows FROM imports WHERE id=?")
      .get(id) as any;
    if (!r) throw Error("导入记录不存在");
    return JSON.parse(r.rows);
  }
  batches(): Batch[] {
    const statuses = [
      "succeeded",
      "failed",
      "cancelled",
      "partial",
      "needs_review",
      "queued",
      "preparing",
      "payment_submitting",
      "processing",
    ];
    const countsSql = statuses
      .map(
        (status) =>
          `COUNT(o.id) FILTER (WHERE o.status='${status}') AS ${status}`,
      )
      .join(",");
    const blocked = this.resumeBlocked();
    return this.db
      .prepare(
        `
      SELECT b.id,b.budget,b.paused,b.reason,b.createdAt,COUNT(o.id) AS total,${countsSql},
      COUNT(o.id) FILTER (WHERE o.status='needs_review' AND EXISTS (
        SELECT 1 FROM settings si WHERE si.key='isolatedReview:'||o.id AND si.value='true'
      )) AS isolated_review
      FROM batches b LEFT JOIN orders o ON o.batchId=b.id
      GROUP BY b.id ORDER BY b.createdAt DESC,b.rowid DESC
    `,
      )
      .all()
      .map((r: any) => ({
        id: r.id,
        budget: r.budget,
        paused: r.paused,
        reason: r.reason,
        createdAt: r.createdAt,
        finished:
          r.total > 0 && r.succeeded + r.failed + r.cancelled === r.total,
        canResume: !!r.paused && r.queued > 0 && !blocked,
        counts: Object.fromEntries(
          ["total", "isolated_review", ...statuses].map((status) => [
            status,
            r[status],
          ]),
        ),
      }));
  }
  orders(): Order[] {
    return this.db
      .prepare("SELECT * FROM orders ORDER BY rowid ASC")
      .all()
      .map((r: any) => ({
        ...r,
        quote: r.quote ? JSON.parse(r.quote) : undefined,
        receipt: r.receipt ? JSON.parse(r.receipt) : undefined,
      })) as Order[];
  }
  order(id: string) {
    return this.orders().find((o) => o.id === id)!;
  }
  events(id: string) {
    return this.db
      .prepare("SELECT * FROM events WHERE orderId=? ORDER BY id")
      .all(id);
  }
  createBatch(
    key: string,
    rows: InputOrder[],
    budget: number,
    allowRepeat = false,
    opts: { priority?: number; source?: string; account?: string } = {},
  ): any {
    if (
      typeof key !== "string" ||
      key.length < 1 ||
      key.length > 100 ||
      !rows.length ||
      rows.length > 1000 ||
      !positiveInt(budget)
    )
      throw Error("批次参数无效");
    const clean = rows.map((r) => {
      if (
        !/^[A-Z0-9]{6}$/.test(r.code) ||
        !QUANTITIES.includes(r.quantity as any) ||
        !positiveInt(r.maxCost)
      )
        throw Error("订单数量或费用无效");
      return {
        code: r.code,
        quantity: r.quantity,
        maxCost: r.maxCost,
        note: String(r.note || "").slice(0, 500),
      };
    });
    if (new Set(clean.map((r) => r.code)).size !== clean.length)
      throw Error("批次内存在重复邀请码");
    if (clean.reduce((s, r) => s + r.maxCost, 0) > budget)
      throw Error("订单费用上限合计超过批次预算");
    const payload = createHash("sha256")
      .update(JSON.stringify({ clean, budget, allowRepeat }))
      .digest("hex");
    return this.transaction(() => {
      const prior = this.db
        .prepare("SELECT * FROM batches WHERE requestKey=?")
        .get(key) as any;
      if (prior) {
        if (prior.payload !== payload) throw Error("同一请求标识的内容不一致");
        return prior;
      }
      for (const r of clean) {
        const old = this.db
          .prepare("SELECT status FROM orders WHERE code=?")
          .all(r.code) as any[];
        if (
          old.some((x) =>
            [
              "queued",
              "preparing",
              "payment_submitting",
              "processing",
              "needs_review",
            ].includes(x.status),
          )
        )
          throw Error(`${r.code} 存在未决订单，不能重复提交`);
        if (
          !allowRepeat &&
          old.some((x) => ["succeeded", "partial"].includes(x.status))
        )
          throw Error(`${r.code} 已充值，请明确允许重复目标`);
      }
      const id = randomUUID(),
        now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO batches(id,requestKey,payload,budget,createdAt) VALUES(?,?,?,?,?)",
        )
        .run(id, key, payload, budget, now);
      for (const r of clean) {
        const oid = randomUUID();
        this.db
          .prepare(
            "INSERT INTO orders(id,batchId,code,quantity,maxCost,note,status,createdAt,updatedAt,priority,source,account) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            oid,
            id,
            r.code,
            r.quantity,
            r.maxCost,
            r.note,
            "queued",
            now,
            now,
            opts.priority ?? 0,
            opts.source ?? "batch",
            opts.account ?? "main",
          );
        this.db
          .prepare(
            "INSERT INTO events(orderId,status,message,createdAt) VALUES(?,?,?,?)",
          )
          .run(oid, "queued", "等待执行", now);
      }
      return { id, budget, paused: 0, createdAt: now };
    });
  }
  createSingleOrder(code: string) {
    const clean = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(clean))
      throw Error("邀请码格式无效，应为 6 位字母数字");
    const cap = PACKAGE_PRICES[30];
    const batch = this.createBatch(
      randomUUID(),
      [{ code: clean, quantity: 30, maxCost: cap, note: "单充" }],
      cap,
      false,
      { priority: 1, source: "single", account: "main" },
    );
    const order = this.db
      .prepare("SELECT id FROM orders WHERE batchId=?")
      .get(batch.id) as any;
    return { orderId: order.id, code: clean };
  }
  singleOrders(): Order[] {
    return this.db
      .prepare("SELECT * FROM orders WHERE source='single' ORDER BY rowid DESC")
      .all()
      .map((r: any) => ({
        ...r,
        quote: r.quote ? JSON.parse(r.quote) : undefined,
        receipt: r.receipt ? JSON.parse(r.receipt) : undefined,
      })) as Order[];
  }
  setStatus(
    id: string,
    status: string,
    message: string,
    extra?: { quote?: Quote; receipt?: Receipt },
  ) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE orders SET status=?,message=?,updatedAt=?,quote=COALESCE(?,quote),receipt=COALESCE(?,receipt),actualQuantity=COALESCE(?,actualQuantity),actualCost=COALESCE(?,actualCost) WHERE id=?",
      )
      .run(
        status,
        message,
        now,
        extra?.quote ? JSON.stringify(extra.quote) : null,
        extra?.receipt ? JSON.stringify(extra.receipt) : null,
        extra?.receipt?.quantity ?? null,
        extra?.receipt?.cost ?? null,
        id,
      );
    this.db
      .prepare(
        "INSERT INTO events(orderId,status,message,createdAt) VALUES(?,?,?,?)",
      )
      .run(id, status, message, now);
  }
  pause(id: string, reason = "用户暂停") {
    this.db
      .prepare("UPDATE batches SET paused=1,reason=? WHERE id=?")
      .run(reason, id);
  }
  queueControl(): { stopped: boolean; reason: string; at?: string } {
    return this.settings("queueControl") || { stopped: false, reason: "" };
  }
  haltQueue(reason: string) {
    if (!this.queueControl().stopped)
      this.settings("queueControl", {
        stopped: true,
        reason,
        at: new Date().toISOString(),
      });
  }
  hasBlockingOrders() {
    return !!this.db
      .prepare(
        `SELECT o.id FROM orders o WHERE
      o.status IN ('preparing','payment_submitting','processing') OR
      (o.status='needs_review' AND NOT EXISTS (
        SELECT 1 FROM settings s WHERE s.key='isolatedReview:'||o.id AND s.value='true'
      ))`,
      )
      .get();
  }
  private resumeBlocked() {
    return this.queueControl().stopped || this.hasBlockingOrders();
  }
  resumeQueue() {
    if (this.hasBlockingOrders())
      throw Error("仍有执行中或未隔离的待核查订单，请先处理");
    this.transaction(() => {
      this.settings("queueControl", {
        stopped: false,
        reason: "",
        at: new Date().toISOString(),
      });
      this.db
        .prepare("DELETE FROM settings WHERE key LIKE 'batchStreak:%'")
        .run();
      this.settings("queueStreak", 0);
    });
  }
  recordOutcome(batchId: string, success: boolean) {
    const key = "batchStreak:" + batchId;
    const streak = success ? 0 : Number(this.settings(key) || 0) + 1;
    this.settings(key, streak);
    const queueStreak = success
      ? 0
      : Number(this.settings("queueStreak") || 0) + 1;
    this.settings("queueStreak", queueStreak);
    if (streak >= 3 || queueStreak >= 3)
      this.haltQueue("连续3单异常，可能系统性问题，已暂停整个队列");
  }
  isolateReview(id: string) {
    this.settings("isolatedReview:" + id, true);
  }
  observeReceipt(receipt: Receipt): boolean {
    if (!Number.isSafeInteger(receipt.messageId)) return false;
    const binding = this.settings("receiptMessage:" + receipt.messageId);
    if (binding) {
      const known = this.order(binding.orderId);
      if (
        known?.receipt &&
        JSON.stringify([
          known.receipt.code,
          known.receipt.quantity,
          known.receipt.cost,
        ]) !== JSON.stringify([receipt.code, receipt.quantity, receipt.cost])
      ) {
        this.settings("unassignedReceipt:" + receipt.messageId, {
          ...receipt,
          reviewCode: known.code,
        });
        this.haltQueue(`回执 ${known.code} 已被修改且字段不匹配，请人工核查`);
        return false;
      }
      return true;
    }
    const candidates = this.orders().filter((o) => {
      if (o.code !== receipt.code || !o.quote?.ref) return false;
      try {
        const ref = JSON.parse(o.quote.ref);
        const floor = ref.startMaxId ?? ref.maxId;
        return (
          Number.isSafeInteger(floor) &&
          (receipt.messageId! > floor || receipt.messageId === ref.id)
        );
      } catch {
        return false;
      }
    });
    if (candidates.length > 1) {
      this.settings("unassignedReceipt:" + receipt.messageId, receipt);
      this.haltQueue(
        `迟到回执 ${receipt.code} 存在多个可能归属的订单，请人工核查`,
      );
      return false;
    }
    if (!candidates.length) return false;
    const o = candidates[0];
    if (!receiptMatches(o, o.quote!, receipt)) {
      this.settings("unassignedReceipt:" + receipt.messageId, receipt);
      this.haltQueue(
        `机器人迟到回执 ${receipt.code} 与订单或报价不匹配，请人工核查`,
      );
      return false;
    }
    if (
      o.status === "needs_review" &&
      this.settings("isolatedReview:" + o.id) === true
    ) {
      this.transaction(() => {
        this.setStatus(
          o.id,
          receipt.quantity === o.quantity ? "succeeded" : "partial",
          "自动补录：收到本单迟到的最终回执",
          { receipt },
        );
        this.settings("receiptMessage:" + receipt.messageId, { orderId: o.id });
        if (receipt.quantity !== o.quantity)
          this.pause(o.batchId, "迟到回执显示部分交付，请核对后继续");
      });
      // This historical wallet snapshot must not replace a newer balance.
      return true;
    }
    if (["succeeded", "partial"].includes(o.status) && o.receipt) {
      if (
        o.receipt.code !== receipt.code ||
        o.receipt.quantity !== receipt.quantity ||
        o.receipt.cost !== receipt.cost
      ) {
        this.settings("unassignedReceipt:" + receipt.messageId, receipt);
        this.haltQueue(
          `订单 ${receipt.code} 收到相互冲突的最终回执，请人工核查`,
        );
        return false;
      }
      this.settings("receiptMessage:" + receipt.messageId, { orderId: o.id });
      return true;
    }
    return o.status === "processing";
  }
  resume(id: string) {
    if (this.queueControl().stopped)
      throw Error("整个队列已暂停，请先恢复执行队列");
    if (this.hasBlockingOrders())
      throw Error("存在需要核查或正在付款的订单，不能恢复");
    if (
      !this.db
        .prepare("SELECT id FROM orders WHERE batchId=? AND status='queued'")
        .get(id)
    )
      throw Error("该批次没有待执行订单，不能恢复");
    this.db.prepare("UPDATE batches SET paused=0,reason='' WHERE id=?").run(id);
  }
  cancel(id: string) {
    return this.transaction(() => {
      const o = this.order(id);
      if (!o || !["queued", "preparing"].includes(o.status))
        throw Error("该订单已提交或已完成，不能取消");
      this.setStatus(id, "cancelled", "用户取消，未提交付款");
    });
  }
  recover() {
    this.transaction(() => {
      for (const o of this.orders()) {
        if (["payment_submitting", "processing"].includes(o.status)) {
          this.setStatus(
            o.id,
            "needs_review",
            "服务重启：付款结果需核查，禁止自动重试",
          );
          this.pause(o.batchId, "未决付款需核查");
          this.haltQueue("服务重启时存在尚未确认的付款，请先人工核查");
        } else if (o.status === "preparing")
          this.setStatus(o.id, "queued", "服务重启，尚未进入付款步骤");
      }
    });
  }
  claim(): Order | null {
    return this.transaction(() => {
      if (this.queueControl().stopped || this.hasBlockingOrders()) return null;
      const r = this.db
        .prepare(
          "SELECT o.id FROM orders o JOIN batches b ON o.batchId=b.id WHERE o.status='queued' AND b.paused=0 ORDER BY o.priority DESC, o.rowid ASC LIMIT 1",
        )
        .get() as any;
      if (!r) return null;
      this.setStatus(r.id, "preparing", "准备订单并核对报价");
      return this.order(r.id);
    });
  }
  beginPayment(id: string, q: Quote): boolean {
    return this.transaction(() => {
      const o = this.order(id);
      if (!o || o.status !== "preparing") return false;
      const b = this.db
        .prepare("SELECT * FROM batches WHERE id=?")
        .get(o.batchId) as any;
      if (b.paused || this.queueControl().stopped) {
        this.setStatus(id, "queued", "批次已暂停，未付款");
        return false;
      }
      if (!this.ownsWorker()) throw Error("执行锁已失效，禁止付款");
      const spent = Number(
        (
          this.db
            .prepare(
              "SELECT COALESCE(SUM(actualCost),0) AS n FROM orders WHERE batchId=?",
            )
            .get(o.batchId) as any
        ).n,
      );
      if (
        q.code !== o.code ||
        q.quantity !== o.quantity ||
        !Number.isSafeInteger(q.cost) ||
        q.cost < 0
      )
        throw new ExecutionError("systemic", "付款确认内容不匹配，禁止付款");
      if (q.cost > o.maxCost || spent + q.cost > b.budget)
        throw new ExecutionError("local", "实际报价超出授权预算，未付款");
      this.setStatus(
        id,
        "payment_submitting",
        "付款提交前已持久化，结果不明时不重试",
        { quote: q },
      );
      return true;
    });
  }
  pendingReceipts(code: string): Receipt[] {
    return this.db
      .prepare(
        "SELECT value FROM settings WHERE key LIKE 'unassignedReceipt:%'",
      )
      .all()
      .map((r: any) => JSON.parse(r.value))
      .filter(
        (r: Receipt & { reviewCode?: string }) =>
          (r.reviewCode ?? r.code) === code,
      );
  }
  resolve(
    id: string,
    resolution: "not_charged" | "record_receipt",
    receipt?: Receipt,
    messageId?: number,
  ) {
    return this.transaction(() => {
      const o = this.order(id);
      if (!o) throw Error("订单不存在");
      const pending = this.pendingReceipts(o.code);
      const same = (a: Receipt, b: Receipt) =>
        a.code === b.code &&
        a.quantity === b.quantity &&
        a.cost === b.cost &&
        a.balance === b.balance;
      const matches =
        resolution === "record_receipt" && receipt
          ? pending.filter((r) => same(r, receipt))
          : pending;
      const selected =
        messageId === undefined
          ? matches.length === 1
            ? matches[0]
            : undefined
          : pending.find((r) => r.messageId === messageId);
      if (
        (messageId !== undefined && !selected) ||
        (pending.length > 0 && !selected)
      )
        throw Error("请选择要处理的机器人回执");
      if (
        o.status !== "needs_review" &&
        (!selected || !["succeeded", "partial", "failed"].includes(o.status))
      )
        throw Error("只能核查未决订单或有冲突回执的已结束订单");
      if (resolution === "not_charged") {
        this.setStatus(
          id,
          o.status === "needs_review" ? "failed" : o.status,
          selected
            ? "管理员已核查：所选回执已人工处理，本操作不重新付款"
            : "管理员已核查未扣款或全额退款，不自动重试",
        );
      } else {
        if (
          !o.quote ||
          !receipt ||
          !receiptMatches(o, o.quote, receipt) ||
          (selected && !same(selected, receipt))
        )
          throw Error("核查回执不匹配");
        if (
          ["succeeded", "partial"].includes(o.status) &&
          o.receipt &&
          (o.receipt.quantity !== receipt.quantity ||
            o.receipt.cost !== receipt.cost)
        )
          throw Error(
            "已完成订单回执不一致，请选择正确归属，不能覆盖已确认交付",
          );
        const saved = {
          ...receipt,
          ...(selected ? { messageId: selected.messageId } : {}),
        };
        this.setStatus(
          id,
          receipt.quantity === o.quantity ? "succeeded" : "partial",
          "管理员补录已核对的机器人最终回执",
          { receipt: saved },
        );
        if (receipt.quantity !== o.quantity)
          this.pause(o.batchId, "人工补录部分交付，请核对后继续");
        if (!selected && this.settings("isolatedReview:" + id) !== true)
          this.settings("wallet", {
            balance: receipt.balance,
            at: new Date().toISOString(),
          });
      }
      if (selected) {
        this.settings("receiptMessage:" + selected.messageId, {
          orderId:
            resolution === "record_receipt"
              ? id
              : "ignored:" + selected.messageId,
        });
        this.db
          .prepare("DELETE FROM settings WHERE key=?")
          .run("unassignedReceipt:" + selected.messageId);
      }
    });
  }
  close() {
    try {
      this.db.prepare("DELETE FROM worker_lock WHERE owner=?").run(this.owner);
    } finally {
      this.db.close();
    }
  }
}
