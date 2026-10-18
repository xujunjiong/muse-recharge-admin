import { terminalPrompts } from "./prompt.js";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { hashPassword } from "../src/app.js";
const rl = terminalPrompts();
try {
  if (existsSync(".env"))
    throw Error(".env 已存在，不覆盖；如需重置密码请手动备份并移开该文件。");
  const password = await rl.ask(
    "设置管理台密码（至少 12 位，输入隐藏）: ",
    true,
  );
  const confirm = await rl.ask("再次输入（输入隐藏）: ", true);
  if (password !== confirm) throw Error("两次输入不一致");
  const example = readFileSync(".env.example", "utf8");
  writeFileSync(
    ".env",
    example.replace(
      "ADMIN_PASSWORD_HASH=",
      "ADMIN_PASSWORD_HASH=" + hashPassword(password),
    ),
    { mode: 0o600 },
  );
  chmodSync(".env", 0o600);
  console.log("配置已保存。默认模拟模式，不会真实扣款。");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  rl.close();
}
