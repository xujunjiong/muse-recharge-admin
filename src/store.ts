import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  QUANTITIES,
  positiveInt,
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
 CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,batchId TEXT REFERENCES batches(id),code TEXT,quantity INTEGER,maxCost INTEGER,note TEXT,status TEXT,actualQuantity REAL,actualCost INTEGER,message TEXT DEFAULT '',quote TEXT,receipt TEXT,createdAt TEXT,updatedAt TEXT,UNIQUE(batchId,code));
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,orderId TEXT,status TEXT,message TEXT,createdAt TEXT);
 CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,rows TEXT,createdAt TEXT);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,csrf TEXT,expires INTEGER);
 CREATE TABLE IF NOT EXISTS worker_lock(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,expires INTEGER,pid INTEGER);`);
    if (
      !(this.db.prepare("PRAGMA table_info(worker_lock)").all() as any[]).some(
        (c) => c.name === "pid",
      )
    )
      this.db.exec("ALTER TABLE worker_lock ADD COLUMN pid INTEGER");
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
  batches() {
    return this.db
      .prepare(
        "SELECT id,budget,paused,reason,createdAt FROM batches ORDER BY rowid DESC",
      )
      .all();
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
            "INSERT INTO orders(id,batchId,code,quantity,maxCost,note,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)",
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
  resume(id: string) {
    if (
      this.db
        .prepare(
          "SELECT id FROM orders WHERE status IN ('needs_review','payment_submitting','processing')",
        )
        .get()
    )
      throw Error("存在需要核查或正在付款的订单，不能恢复");
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
        } else if (o.status === "preparing")
          this.setStatus(o.id, "queued", "服务重启，尚未进入付款步骤");
      }
    });
  }
  claim(): Order | null {
    return this.transaction(() => {
      if (
        this.db
          .prepare(
            "SELECT id FROM orders WHERE status IN ('preparing','payment_submitting','processing','needs_review')",
          )
          .get()
      )
        return null;
      const r = this.db
        .prepare(
          "SELECT o.id FROM orders o JOIN batches b ON o.batchId=b.id WHERE o.status='queued' AND b.paused=0 ORDER BY o.rowid LIMIT 1",
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
      if (b.paused) {
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
        q.cost < 0 ||
        q.cost > o.maxCost ||
        spent + q.cost > b.budget
      )
        throw Error("邀请码、数量或实际报价超出授权预算");
      this.setStatus(
        id,
        "payment_submitting",
        "付款提交前已持久化，结果不明时不重试",
        { quote: q },
      );
      return true;
    });
  }
  resolve(
    id: string,
    resolution: "not_charged" | "record_receipt",
    receipt?: Receipt,
  ) {
    return this.transaction(() => {
      const o = this.order(id);
      if (!o || o.status !== "needs_review") throw Error("只能核查未决订单");
      if (resolution === "not_charged")
        this.setStatus(
          id,
          "failed",
          "管理员已核查未扣款或全额退款，不自动重试",
        );
      else {
        if (
          !o.quote ||
          !receipt ||
          receipt.cost > o.quote.cost ||
          (receipt.quantity === o.quantity && receipt.cost !== o.quote.cost) ||
          receipt.code !== o.code ||
          receipt.quantity <= 0 ||
          receipt.quantity > o.quantity ||
          receipt.cost > o.maxCost ||
          receipt.cost < 0
        )
          throw Error("核查回执不匹配");
        this.setStatus(
          id,
          receipt.quantity === o.quantity ? "succeeded" : "partial",
          "管理员补录已核对的机器人最终回执",
          { receipt },
        );
        this.settings("wallet", {
          balance: receipt.balance,
          at: new Date().toISOString(),
        });
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
