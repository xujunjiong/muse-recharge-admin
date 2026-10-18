import "dotenv/config";
import { readSavedLogin } from "../src/telegram-login.js";
const saved = readSavedLogin(
  process.env.TELEGRAM_LOGIN_FILE || "data/telegram-login.json",
);
import { TelegramAdapter } from "../src/adapters/telegram.js";
const code = process.argv[2];
if (!/^[A-Z0-9]{6}$/.test(code || ""))
  throw Error("用法：npm run probe:telegram -- YOURCODE（填真实六位邀请码）");
const a = await TelegramAdapter.connect({
  apiId: saved?.apiId ?? Number(process.env.TELEGRAM_API_ID),
  apiHash: saved?.apiHash ?? process.env.TELEGRAM_API_HASH ?? "",
  session: saved?.session,
  sessionFile: process.env.TELEGRAM_SESSION_FILE || "data/telegram.session",
  expectedBotId: process.env.TELEGRAM_BOT_ID || "8647262682",
});
try {
  const q = await a.prepare({ code, quantity: 1, maxCost: 1700 });
  console.log(
    JSON.stringify(
      { code: q.code, quantity: q.quantity, cost: q.cost, submitted: false },
      null,
      2,
    ),
  );
  console.log("探测停在最终确认页，没有付款。请回到机器人取消该确认页。");
} finally {
  await a.close();
}
