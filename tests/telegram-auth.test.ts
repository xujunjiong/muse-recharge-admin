import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TelegramLogin, type LoginTransport } from "../src/telegram-login.js";
const credentials = {
  apiId: 12345,
  apiHash: "0123456789abcdef0123456789abcdef",
  phone: "+6581234567",
};
function setup(twoFactor = false) {
  const dir = mkdtempSync(join(process.cwd(), ".test-auth-"));
  let calls = 0;
  const driver: LoginTransport = {
    sendCode: async () => {
      calls++;
      return { viaApp: true };
    },
    signIn: async (code) => {
      if (code === "00000") throw { errorMessage: "PHONE_CODE_INVALID" };
      if (twoFactor) throw { errorMessage: "SESSION_PASSWORD_NEEDED" };
      return { id: "123", name: "Test" };
    },
    password: async (pass) => {
      if (pass !== "correct") throw { errorMessage: "PASSWORD_HASH_INVALID" };
      return { id: "123", name: "Test" };
    },
    session: () => "test-session-secret",
    close: async () => {},
  };
  const login = new TelegramLogin(
    join(dir, "login.json"),
    async () => driver,
    () => false,
  );
  return {
    login,
    dir,
    file: join(dir, "login.json"),
    calls: () => calls,
    cleanup: async () => {
      await login.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("web phone/code flow saves a private session without exposing secrets in status", async () => {
  const f = setup();
  try {
    assert.equal(f.login.status().configured, false);
    await f.login.start(credentials);
    assert.equal(f.login.status().phase, "code");
    assert.ok(!JSON.stringify(f.login.status()).includes(credentials.apiHash));
    await f.login.code("12345");
    assert.equal(f.login.status().phase, "saved");
    const saved = JSON.parse(readFileSync(f.file, "utf8"));
    assert.equal(saved.session, "test-session-secret");
    assert.equal(statSync(f.file).mode & 0o777, 0o600);
    assert.ok(
      !JSON.stringify(f.login.status()).includes("test-session-secret"),
    );
  } finally {
    await f.cleanup();
  }
});
test("two-factor password is requested only when Telegram requires it", async () => {
  const f = setup(true);
  try {
    await f.login.start(credentials);
    await f.login.code("12345");
    assert.equal(f.login.status().phase, "password");
    await assert.rejects(f.login.password("wrong"), /密码/);
    assert.equal(f.login.status().phase, "password");
    await f.login.password("correct");
    assert.equal(f.login.status().phase, "saved");
    assert.ok(!readFileSync(f.file, "utf8").includes("correct"));
  } finally {
    await f.cleanup();
  }
});
test("invalid verification is retryable without resending code and attempts are bounded", async () => {
  const f = setup();
  try {
    await f.login.start(credentials);
    for (let i = 0; i < 5; i++)
      await assert.rejects(f.login.code("00000"), /验证码|次数/);
    assert.equal(f.calls(), 1);
    assert.equal(f.login.status().phase, "idle");
    await assert.rejects(f.login.start(credentials), /稍后|频繁/);
  } finally {
    await f.cleanup();
  }
});
test("login is blocked while orders exist and credentials are validated before network calls", async () => {
  const f = setup();
  try {
    await assert.rejects(
      f.login.start({ ...credentials, phone: "bad" }),
      /手机号/,
    );
    assert.equal(f.calls(), 0);
    f.login.blocked = () => true;
    await assert.rejects(f.login.start(credentials), /订单|任务/);
    assert.equal(f.calls(), 0);
  } finally {
    await f.cleanup();
  }
});
test("login requests can follow Telegram DC migration before resend", async () => {
  const { LOGIN_OPTIONS } = await import("../src/telegram-login.js");
  const { invoke } = await import("telegram/client/users.js");
  const { Api, errors } = await import("telegram");
  let sends = 0,
    migrations = 0;
  const sender = {
    userDisconnected: false,
    addStateToQueue(state: any) {
      sends++;
      if (sends === 1)
        state.reject(new errors.PhoneMigrateError({ capture: 2 } as any));
      else state.resolve({ ok: true });
    },
  };
  const client: any = {
    _sender: sender,
    _requestRetries: LOGIN_OPTIONS.requestRetries,
    _connectedDeferred: { promise: Promise.resolve() },
    session: { processEntities() {} },
    _entityCache: { add() {} },
    _log: { info() {}, warn() {} },
    isUserAuthorized: async () => false,
    _switchDC: async () => {
      migrations++;
    },
  };
  const result = await invoke(
    client,
    new Api.auth.SendCode({
      phoneNumber: credentials.phone,
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      settings: new Api.CodeSettings({}),
    }),
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(sends, 2);
  assert.equal(migrations, 1);
});
