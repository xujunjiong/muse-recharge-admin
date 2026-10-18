import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export const LOGIN_OPTIONS = {
  connectionRetries: 2,
  requestRetries: 3,
  floodSleepThreshold: 0,
};
export type LoginIdentity = { id: string; name: string };
export type LoginTransport = {
  sendCode: (phone: string) => Promise<{ viaApp: boolean }>;
  signIn: (code: string) => Promise<LoginIdentity>;
  password: (password: string) => Promise<LoginIdentity>;
  session: () => string;
  close: () => Promise<void>;
};
export type SavedLogin = {
  apiId: number;
  apiHash: string;
  session: string;
  user: LoginIdentity;
  phone: string;
};
export function readSavedLogin(file: string): SavedLogin | null {
  if (!existsSync(file)) return null;
  const x = JSON.parse(readFileSync(file, "utf8"));
  if (
    !Number.isSafeInteger(x.apiId) ||
    !/^[a-f0-9]{32}$/i.test(x.apiHash) ||
    typeof x.session !== "string" ||
    !x.session ||
    typeof x.user?.id !== "string"
  )
    throw Error("Telegram 会话配置损坏，请在页面重新登录");
  return x;
}
function safeError(e: unknown) {
  const key = (e as any)?.errorMessage;
  const messages: Record<string, string> = {
    PHONE_CODE_INVALID: "验证码不正确，请重新输入",
    PHONE_CODE_EXPIRED: "验证码已过期，请取消后重新登录",
    PASSWORD_HASH_INVALID: "两步验证密码不正确",
    PHONE_NUMBER_INVALID: "手机号无效",
    PHONE_NUMBER_BANNED: "该手机号暂时无法登录",
    API_ID_INVALID: "开发者凭据不正确，请检查首次配置",
    AUTH_RESTART: "Telegram 要求重新登录，请稍后重试",
    SIGNUP_REQUIRED: "此手机号尚未注册 Telegram，请先在官方客户端注册",
  };
  return messages[key] || "Telegram 登录未完成，请检查连接或稍后重试";
}
export class TelegramLogin {
  private driver: LoginTransport | null = null;
  private phase: "idle" | "code" | "password" | "saved" = "idle";
  private busy = false;
  private phone = "";
  private creds: { apiId: number; apiHash: string } | null = null;
  private attempts = 0;
  private nextStart = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private viaApp = false;
  constructor(
    public file: string,
    private factory: (c: {
      apiId: number;
      apiHash: string;
    }) => Promise<LoginTransport>,
    public blocked: () => boolean,
    private defaults?: { apiId: number; apiHash: string },
    private onSaved?: () => Promise<void>,
    private saveLock?: (fn: () => Promise<void>) => Promise<void>,
  ) {
    try {
      if (readSavedLogin(file)) this.phase = "saved";
    } catch {}
  }
  status() {
    let configured = !!this.defaults?.apiId && !!this.defaults.apiHash;
    try {
      configured = !!readSavedLogin(this.file) || configured;
    } catch {}
    return {
      phase: this.phase,
      busy: this.busy,
      configured,
      phone: this.phone
        ? this.phone.slice(0, 3) + "••••" + this.phone.slice(-3)
        : "",
      viaApp: this.viaApp,
    };
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.busy) throw Error("登录操作正在处理中，请稍候");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  async start(input: { phone: string; apiId?: number; apiHash?: string }) {
    return this.exclusive(async () => {
      if (this.blocked())
        throw Error("有未完成订单，请先处理或取消任务，再更改 Telegram 登录");
      if (Date.now() < this.nextStart)
        throw Error("验证码请求频繁，请稍后再试");
      const phone = String(input.phone || "").replace(/[\s-]/g, "");
      if (!/^\+[1-9]\d{6,14}$/.test(phone))
        throw Error("请输入含国家码的手机号，例如 +65…");
      let saved: SavedLogin | null = null;
      try {
        saved = readSavedLogin(this.file);
      } catch {}
      const c = {
        apiId: Number(input.apiId || saved?.apiId || this.defaults?.apiId),
        apiHash: String(
          input.apiHash || saved?.apiHash || this.defaults?.apiHash || "",
        ),
      };
      if (
        !Number.isSafeInteger(c.apiId) ||
        c.apiId <= 0 ||
        c.apiId > 2147483647 ||
        !/^[a-f0-9]{32}$/i.test(c.apiHash)
      )
        throw Error("首次需要配置有效的 api_id 和 api_hash");
      this.nextStart = Date.now() + 60000;
      await this.reset();
      this.phone = phone;
      this.creds = c;
      try {
        this.driver = await this.factory(c);
        const r = await this.driver.sendCode(phone);
        this.viaApp = r.viaApp;
        this.phase = "code";
        this.attempts = 0;
        this.timer = setTimeout(() => void this.reset(), 5 * 60000);
        this.timer.unref();
        return this.status();
      } catch (e) {
        await this.reset();
        throw Error(safeError(e));
      }
    });
  }
  async code(code: string) {
    return this.exclusive(async () => {
      if (this.phase !== "code" || !this.driver) throw Error("请先获取验证码");
      if (!/^\d{4,8}$/.test(code)) throw Error("验证码格式不正确");
      this.attempts++;
      try {
        const user = await this.driver.signIn(code);
        await this.save(user);
        return this.status();
      } catch (e) {
        if ((e as any)?.errorMessage === "SESSION_PASSWORD_NEEDED") {
          this.phase = "password";
          return this.status();
        }
        if (this.attempts >= 5) {
          await this.reset();
          throw Error("验证次数过多，请稍后重新登录");
        }
        throw Error(safeError(e));
      }
    });
  }
  async password(password: string) {
    return this.exclusive(async () => {
      if (this.phase !== "password" || !this.driver)
        throw Error("当前不需要两步验证密码");
      if (!password || password.length > 256) throw Error("密码长度无效");
      this.attempts++;
      try {
        const user = await this.driver.password(password);
        await this.save(user);
        return this.status();
      } catch (e) {
        if (this.attempts >= 5) {
          await this.reset();
          throw Error("验证次数过多，请稍后重新登录");
        }
        throw Error(safeError(e));
      }
    });
  }
  private async save(user: LoginIdentity) {
    if (this.blocked()) throw Error("订单状态变化，暂不保存新会话");
    if (!this.driver || !this.creds || !user.id) throw Error("登录未完成");
    const session = this.driver.session();
    if (!session) throw Error("登录未完成");
    const persist = async () => {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = this.file + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(
          temp,
          JSON.stringify({ ...this.creds, session, user, phone: this.phone }),
          { mode: 0o600, flag: "wx" },
        );
        chmodSync(temp, 0o600);
        renameSync(temp, this.file);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
      await this.reset();
      this.phase = "saved";
      await this.onSaved?.();
    };
    if (this.saveLock) await this.saveLock(persist);
    else await persist();
  }
  private async reset() {
    if (this.timer) clearTimeout(this.timer);
    const driver = this.driver;
    this.driver = null;
    this.creds = null;
    this.phone = "";
    this.phase = "idle";
    if (driver) await driver.close().catch(() => {});
  }
  async cancel() {
    return this.exclusive(async () => {
      await this.reset();
      if (existsSync(this.file)) this.phase = "saved";
      return this.status();
    });
  }
  async close() {
    await this.reset();
  }
}
export async function createLoginTransport(credentials: {
  apiId: number;
  apiHash: string;
}): Promise<LoginTransport> {
  const { TelegramClient, Api } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");
  const { computeCheck } = await import("telegram/Password.js");
  const client = new TelegramClient(
    new StringSession(""),
    credentials.apiId,
    credentials.apiHash,
    LOGIN_OPTIONS,
  );
  client.setLogLevel("none" as any);
  try {
    await client.connect();
  } catch (e) {
    await client.disconnect();
    throw e;
  }
  let phone = "",
    hash = "";
  const identity = (r: any): LoginIdentity => {
    if (r instanceof Api.auth.AuthorizationSignUpRequired || !r.user)
      throw { errorMessage: "SIGNUP_REQUIRED" };
    return {
      id: String(r.user.id),
      name: String(r.user.firstName || "Telegram 用户").slice(0, 80),
    };
  };
  return {
    async sendCode(number) {
      phone = number;
      const r = await client.invoke(
        new Api.auth.SendCode({
          phoneNumber: phone,
          apiId: credentials.apiId,
          apiHash: credentials.apiHash,
          settings: new Api.CodeSettings({}),
        }),
      );
      if (!(r instanceof Api.auth.SentCode))
        throw Error("unexpected authorization response");
      hash = r.phoneCodeHash;
      return { viaApp: r.type instanceof Api.auth.SentCodeTypeApp };
    },
    async signIn(code) {
      return identity(
        await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: phone,
            phoneCodeHash: hash,
            phoneCode: code,
          }),
        ),
      );
    },
    async password(password) {
      const parameters = await client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(parameters, password);
      return identity(
        await client.invoke(new Api.auth.CheckPassword({ password: check })),
      );
    },
    session: () => client.session.save() as unknown as string,
    close: async () => {
      await client.disconnect();
    },
  };
}
