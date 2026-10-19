import "dotenv/config";
import type { BotAdapter } from "./types.js";
import { resolve } from "node:path";
import { Store } from "./store.js";
import { Worker } from "./worker.js";
import { MockAdapter } from "./adapters/mock.js";
import { ManagedTelegram } from "./adapters/managed-telegram.js";
import { TelegramLogin, createLoginTransport } from "./telegram-login.js";
import { createApp } from "./app.js";
if (!process.env.ADMIN_PASSWORD_HASH)
  throw Error("尚未设置管理员密码，请先运行 npm run setup");
if (
  process.env.BOT_MODE &&
  !["mock", "telegram"].includes(process.env.BOT_MODE)
)
  throw Error("BOT_MODE 只能为 mock 或 telegram");
const mode = process.env.BOT_MODE || "mock";
if (mode === "telegram" && process.env.LIVE_PAYMENTS_ENABLED !== "YES")
  throw Error(
    "真实模式未开启付款，请先完成不付款探测，再在服务器设置 LIVE_PAYMENTS_ENABLED=YES",
  );
const adapter: BotAdapter =
  mode === "mock"
    ? new MockAdapter()
    : new ManagedTelegram({
        loginFile: resolve(
          process.env.TELEGRAM_LOGIN_FILE || "data/telegram-login.json",
        ),
        apiId: Number(process.env.TELEGRAM_API_ID),
        apiHash: process.env.TELEGRAM_API_HASH || "",
        sessionFile: resolve(
          process.env.TELEGRAM_SESSION_FILE || "data/telegram.session",
        ),
        expectedBotId: process.env.TELEGRAM_BOT_ID || "8647262682",
      });
const store = new Store(
  resolve(process.env.DATABASE_FILE || "data/muse.sqlite"),
);
store.enforceMode(mode);
const worker = new Worker(store, adapter);
if (mode === "mock")
  store.settings("wallet", {
    balance: await adapter.balance(),
    at: new Date().toISOString(),
  });
const telegramLogin = new TelegramLogin(
  resolve(process.env.TELEGRAM_LOGIN_FILE || "data/telegram-login.json"),
  createLoginTransport,
  () =>
    worker.busy ||
    worker.maintenance ||
    store
      .orders()
      .some((o) =>
        [
          "queued",
          "preparing",
          "payment_submitting",
          "processing",
          "needs_review",
        ].includes(o.status),
      ),
  {
    apiId: Number(process.env.TELEGRAM_API_ID),
    apiHash: process.env.TELEGRAM_API_HASH || "",
  },
  async () => {
    if (adapter instanceof ManagedTelegram) {
      store.settings("wallet", { balance: null, at: new Date().toISOString() });
      try {
        await adapter.connect();
      } catch {
        store.settings(
          "connectionError",
          "Telegram 会话已保存，连接尚未完成，请在页面刷新余额重试",
        );
      }
    }
  },
  async (persist) => {
    if (
      worker.busy ||
      worker.maintenance ||
      store
        .orders()
        .some((o) =>
          [
            "queued",
            "preparing",
            "payment_submitting",
            "processing",
            "needs_review",
          ].includes(o.status),
        )
    )
      throw Error("有执行中任务，暂不能更换会话");
    worker.maintenance = true;
    try {
      await persist();
    } finally {
      worker.maintenance = false;
    }
  },
);
worker.start();
if (adapter instanceof ManagedTelegram) {
  store.settings("wallet", { balance: null, at: new Date().toISOString() });
  try {
    await adapter.connect();
  } catch {
    store.settings("connectionError", "等待在管理页连接 Telegram");
  }
}
const app = createApp({
  store,
  worker,
  adapter,
  passwordHash: process.env.ADMIN_PASSWORD_HASH,
  telegramLogin,
  origin: process.env.APP_ORIGIN,
  secureCookie: process.env.COOKIE_SECURE === "true",
});
const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(
    `Muse Admin: http://127.0.0.1:${port} (${mode === "mock" ? "模拟模式，不会真实扣款" : "真实充值模式"})`,
  );
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  worker.stop();
  app.close();
  if (worker.busy) {
    console.log("等待当前订单结束；若被强制终止，重启后将进入待核查。");
    while (worker.busy) await new Promise((r) => setTimeout(r, 500));
  }
  await telegramLogin.close();
  await adapter.close?.();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
