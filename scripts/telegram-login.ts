import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { terminalPrompts } from "./prompt.js";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
const rl = terminalPrompts();
try {
  const apiId = Number(
    process.env.TELEGRAM_API_ID || (await rl.ask("Telegram api_id: ")),
  );
  const apiHash =
    process.env.TELEGRAM_API_HASH ||
    (await rl.ask("Telegram api_hash（输入隐藏）: ", true));
  if (!apiId || !apiHash) throw Error("缺少开发者凭据");
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
  });
  client.setLogLevel("none" as any);
  await client.start({
    phoneNumber: () => rl.ask("手机号（含国家码）: "),
    phoneCode: () => rl.ask("Telegram 验证码（输入隐藏）: ", true),
    password: () => rl.ask("两步验证密码（输入隐藏）: ", true),
    onError: () => {
      console.error("登录未完成，请检查 Telegram 提示。");
    },
  });
  const file = resolve(
    process.env.TELEGRAM_SESSION_FILE || "data/telegram.session",
  );
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, client.session.save() as unknown as string, {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
  console.log("登录会话已保存；未发送消息或下单。");
  await client.disconnect();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  rl.close();
}
