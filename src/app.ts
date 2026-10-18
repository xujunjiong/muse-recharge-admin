import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Store } from "./store.js";
import { Worker } from "./worker.js";
import { parseWorkbook, templateWorkbook } from "./importer.js";
import { parseReceipt } from "./receipts.js";
import type { TelegramLogin } from "./telegram-login.js";
import type { BotAdapter, Candidate } from "./types.js";
export function hashPassword(password: string) {
  if (password.length < 12) throw Error("管理员密码至少 12 位");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function verify(password: string, hash: string) {
  try {
    const [salt, key] = hash.split(":");
    const got = scryptSync(password, salt, 64),
      want = Buffer.from(key, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
const tokenHash = (s: string) => createHash("sha256").update(s).digest("hex");
async function body(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Error("请求文件或内容超过大小限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function csv(s: unknown) {
  let text = String(s ?? "");
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function createApp(config: {
  store: Store;
  worker: Worker;
  adapter: BotAdapter;
  passwordHash: string;
  publicDir?: string;
  origin?: string;
  secureCookie?: boolean;
  telegramLogin?: TelegramLogin;
}) {
  const { store, worker, adapter } = config;
  const runtimeReady = () => adapter.ready !== false;
  const publicDir = config.publicDir || resolve("public");
  const limits = new Map<string, { count: number; until: number }>();
  let botBusy = false;
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const host = req.headers.host || "";
      const origin = config.origin || `http://${host}`;
      const hostName = host.replace(/:\d+$/, "");
      if (
        config.origin
          ? host !== new URL(config.origin).host
          : !["localhost", "127.0.0.1", "[::1]"].includes(hostName)
      ) {
        json(403, { error: "Host 不受信任" });
        return;
      }
      const url = new URL(req.url || "/", origin),
        path = url.pathname;
      const post = req.method === "POST";
      if (!["GET", "POST"].includes(req.method || "")) {
        json(405, { error: "方法不允许" });
        return;
      }
      if (post && req.headers.origin !== origin) {
        json(403, { error: "请求来源不匹配" });
        return;
      }
      const auth =
        req.headers.cookie
          ?.split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("muse_session="))
          ?.slice(13) || "";
      const session = auth
        ? (store.db
            .prepare("SELECT * FROM sessions WHERE hash=? AND expires>?")
            .get(tokenHash(auth), Date.now()) as any)
        : null;
      if (path === "/api/login" && post) {
        const ip = req.socket.remoteAddress || "local";
        const l = limits.get(ip);
        if (l && l.until > Date.now() && l.count >= 10) {
          json(429, { error: "尝试过多，请 15 分钟后重试" });
          return;
        }
        const reserved =
          l && l.until > Date.now()
            ? l
            : { count: 0, until: Date.now() + 15 * 60 * 1000 };
        reserved.count++;
        limits.set(ip, reserved);
        const data = JSON.parse((await body(req, 4096)).toString());
        if (
          typeof data.password !== "string" ||
          data.password.length > 256 ||
          !verify(data.password, config.passwordHash)
        ) {
          json(401, { error: "密码不正确" });
          return;
        }
        const token = randomBytes(32).toString("hex"),
          csrf = randomBytes(24).toString("hex");
        store.db
          .prepare("DELETE FROM sessions WHERE expires<?")
          .run(Date.now());
        store.db
          .prepare("INSERT INTO sessions VALUES(?,?,?)")
          .run(tokenHash(token), csrf, Date.now() + 8 * 3600000);
        res.setHeader(
          "Set-Cookie",
          `muse_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${config.secureCookie ? "; Secure" : ""}`,
        );
        json(200, { csrf });
        return;
      }
      if (path.startsWith("/api/")) {
        if (!session) {
          json(401, { error: "请先登录" });
          return;
        }
        if (post && req.headers["x-csrf-token"] !== session.csrf) {
          json(403, { error: "安全令牌不匹配，请刷新页面" });
          return;
        }
        if (path.startsWith("/api/telegram/")) {
          const flow = config.telegramLogin;
          if (!flow) {
            json(503, { error: "当前服务未启用 Telegram 网页登录" });
            return;
          }
          if (path === "/api/telegram/status" && !post) {
            json(200, {
              ...flow.status(),
              runtimeConnected: adapter.ready === true,
            });
            return;
          }
          if (!post) {
            json(405, { error: "方法不允许" });
            return;
          }
          const safeOrigin = new URL(origin);
          if (
            safeOrigin.protocol !== "https:" &&
            !["127.0.0.1", "localhost", "[::1]"].includes(safeOrigin.hostname)
          )
            throw Error("Telegram 登录仅支持 HTTPS 或本机 SSH 隧道访问");
          const d = JSON.parse((await body(req, 4096)).toString());
          let result;
          if (path === "/api/telegram/start")
            result = await flow.start({
              phone: String(d.phone || ""),
              apiId: Number(d.apiId),
              apiHash: String(d.apiHash || ""),
            });
          else if (path === "/api/telegram/code")
            result = await flow.code(String(d.code || ""));
          else if (path === "/api/telegram/password")
            result = await flow.password(String(d.password || ""));
          else if (path === "/api/telegram/cancel")
            result = await flow.cancel();
          else {
            json(404, { error: "接口不存在" });
            return;
          }
          json(200, { ...result, runtimeConnected: adapter.ready === true });
          return;
        }
        if (path === "/api/session" && !post) {
          json(200, { csrf: session.csrf });
          return;
        }
        if (path === "/api/logout" && post) {
          store.db
            .prepare("DELETE FROM sessions WHERE hash=?")
            .run(tokenHash(auth));
          res.setHeader(
            "Set-Cookie",
            "muse_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          );
          json(200, { ok: true });
          return;
        }
        if (path === "/api/state" && !post) {
          json(200, {
            mode: adapter.mode,
            busy: worker.busy || botBusy,
            wallet: store.settings("wallet"),
            orders: store.orders(),
            batches: store.batches(),
            connected:
              adapter.mode === "mock"
                ? "模拟模式"
                : !runtimeReady()
                  ? "等待 Telegram 登录"
                  : "会话已连接",
            telegramLogin: config.telegramLogin
              ? {
                  ...config.telegramLogin.status(),
                  runtimeConnected: adapter.ready === true,
                }
              : null,
          });
          return;
        }
        if (path === "/api/refresh-balance" && post) {
          const loginStatus = config.telegramLogin?.status();
          if (
            loginStatus &&
            (loginStatus.busy ||
              ["code", "password"].includes(loginStatus.phase))
          )
            throw Error("请先完成或取消 Telegram 登录");
          if (
            worker.busy ||
            botBusy ||
            store
              .orders()
              .some((o) =>
                ["payment_submitting", "processing", "needs_review"].includes(
                  o.status,
                ),
              )
          )
            throw Error("有执行中或未决订单，暂不操作机器人菜单");
          botBusy = true;
          worker.maintenance = true;
          try {
            const balance = await adapter.balance();
            store.settings("wallet", { balance, at: new Date().toISOString() });
            json(200, { balance });
          } catch (e) {
            store.settings("wallet", {
              balance: null,
              at: new Date().toISOString(),
              error: "余额查询失败",
            });
            throw e;
          } finally {
            botBusy = false;
            worker.maintenance = false;
          }
          return;
        }
        if (path === "/api/template" && !post) {
          const b = await templateWorkbook();
          res.writeHead(200, {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition":
              'attachment; filename="muse-import-template.xlsx"',
          });
          res.end(b);
          return;
        }
        if (path === "/api/import" && post) {
          const rows = await parseWorkbook(await body(req, 5 * 1024 * 1024));
          const id = store.saveImport(rows);
          json(200, { id, rows });
          return;
        }
        if (path === "/api/batches" && post) {
          if (!runtimeReady())
            throw Error("请先在 Telegram 连接页完成登录并刷新余额");
          const loginStatus = config.telegramLogin?.status();
          if (
            loginStatus &&
            (loginStatus.busy ||
              ["code", "password"].includes(loginStatus.phase))
          )
            throw Error("正在更改 Telegram 登录，请完成或取消后再创建批次");
          const data = JSON.parse((await body(req, 128 * 1024)).toString());
          if (
            !Array.isArray(data.rows) ||
            new Set(data.rows).size !== data.rows.length
          )
            throw Error("选中行有误");
          const candidates = store.getImport(data.importId) as Candidate[];
          const rows = data.rows.map((n: unknown) => {
            const r = candidates.find((r) => r.row === n);
            if (!r || r.errors.length) throw Error("包含无效导入行");
            return {
              code: r.code,
              quantity: data.quantity ?? r.quantity,
              maxCost: data.maxCost ?? r.maxCost,
              note: r.note,
            };
          });
          if (
            !store.db
              .prepare("SELECT id FROM batches WHERE requestKey=?")
              .get(String(data.key))
          ) {
            const wallet = store.settings("wallet");
            const sum = rows.reduce(
              (n: number, r: any) => n + Number(r.maxCost),
              0,
            );
            if (
              !wallet ||
              !Number.isSafeInteger(wallet.balance) ||
              !Number.isFinite(sum) ||
              wallet.balance < sum
            )
              throw Error("余额未知或不足，请刷新余额或减少订单");
          }
          const latestLogin = config.telegramLogin?.status();
          if (
            !runtimeReady() ||
            (latestLogin &&
              (latestLogin.busy ||
                ["code", "password"].includes(latestLogin.phase)))
          )
            throw Error("Telegram 登录状态已变化，请稍后重新提交批次");
          const b = store.createBatch(
            data.key,
            rows,
            Number(data.budget),
            data.allowRepeat === true,
          );
          json(200, b);
          return;
        }
        const action = path.match(
          /^\/api\/batches\/([a-zA-Z0-9-]+)\/(pause|resume)$/,
        );
        if (action && post) {
          if (action[2] === "pause") store.pause(action[1]);
          else store.resume(action[1]);
          json(200, { ok: true });
          return;
        }
        const cancel = path.match(/^\/api\/orders\/([a-zA-Z0-9-]+)\/cancel$/);
        if (cancel && post) {
          store.cancel(cancel[1]);
          json(200, { ok: true });
          return;
        }
        const review = path.match(/^\/api\/orders\/([a-zA-Z0-9-]+)\/resolve$/);
        if (review && post) {
          if (worker.busy) throw Error("当前仍有任务处理中");
          const data = JSON.parse((await body(req, 32 * 1024)).toString());
          if (data.resolution === "not_charged")
            store.resolve(review[1], "not_charged");
          else if (data.resolution === "record_receipt") {
            const receipt = parseReceipt(String(data.receipt || ""));
            if (!receipt) throw Error("不是可识别的机器人最终成功回执");
            store.resolve(review[1], "record_receipt", receipt);
          } else throw Error("核查方式无效");
          json(200, { ok: true });
          return;
        }
        const details = path.match(/^\/api\/orders\/([a-zA-Z0-9-]+)$/);
        if (details && !post) {
          const o = store.order(details[1]);
          if (!o) {
            json(404, { error: "订单不存在" });
            return;
          }
          json(200, { order: o, events: store.events(o.id) });
          return;
        }
        if (path === "/api/export" && !post) {
          const lines = [
            [
              "邀请码",
              "充值量B",
              "费用上限IDR",
              "状态",
              "实际交付B",
              "实际扣款IDR",
              "完成时间",
              "备注",
              "结果",
            ],
            ...store
              .orders()
              .map((o) => [
                o.code,
                o.quantity,
                o.maxCost,
                o.status,
                o.actualQuantity,
                o.actualCost,
                o.updatedAt,
                o.note,
                o.message,
              ]),
          ];
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="muse-results.csv"',
          });
          res.end(
            "\uFEFF" + lines.map((l) => l.map(csv).join(",")).join("\r\n"),
          );
          return;
        }
        json(404, { error: "接口不存在" });
        return;
      }
      const files: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript"],
        "/app.css": ["app.css", "text/css"],
      };
      if (req.method !== "GET" || !files[path]) {
        json(404, { error: "页面不存在" });
        return;
      }
      const [file, type] = files[path];
      try {
        res.writeHead(200, { "Content-Type": type });
        res.end(await readFile(resolve(publicDir, file)));
      } catch {
        res.end("页面尚未构建，请运行 npm run build");
      }
    } catch (e) {
      if (!res.headersSent)
        json(400, { error: (e as Error).message.slice(0, 500) });
      else res.end();
    }
  });
}
