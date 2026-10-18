import React, { useState } from "react";
type View = {
  phase: "idle" | "code" | "password" | "saved";
  configured: boolean;
  busy: boolean;
  phone: string;
  viaApp: boolean;
  runtimeConnected: boolean;
};
export function TelegramConnection({
  value,
  mode,
  api,
  refresh,
}: {
  value: View | null;
  mode: string;
  api: (p: string, b?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [phone, setPhone] = useState(""),
    [apiId, setApiId] = useState(""),
    [apiHash, setApiHash] = useState(""),
    [code, setCode] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [advanced, setAdvanced] = useState(false);
  const view = value || {
    phase: "idle",
    configured: false,
    busy: false,
    phone: "",
    viaApp: true,
    runtimeConnected: false,
  };
  async function send(kind: string, data: unknown) {
    setBusy(true);
    setError("");
    try {
      await api("telegram/" + kind, data);
      if (kind === "start") {
        setApiHash("");
        setCode("");
        setPassword("");
      }
      if (kind === "code") setCode("");
      if (kind === "password") setPassword("");
      if (kind === "cancel") {
        setCode("");
        setPassword("");
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  const waiting = busy || view.busy;
  return (
    <section className="table-card connection-card">
      <div className="section-heading">
        <div>
          <h2>连接你的 Telegram 账号</h2>
          <p>在这里完成登录，无需在服务器终端输入验证码。</p>
        </div>
        <span
          className={
            "badge " + (view.phase === "saved" ? "succeeded" : "queued")
          }
        >
          {view.runtimeConnected
            ? "已连接"
            : view.phase === "saved"
              ? "会话已保存"
              : "尚未连接"}
        </span>
      </div>
      <div className="connection-body">
        <div className="connection-form">
          <div className="login-steps">
            <span
              className={
                !["code", "password"].includes(view.phase) ? "current" : ""
              }
            >
              01 手机号
            </span>
            <span className={view.phase === "code" ? "current" : ""}>
              02 验证码
            </span>
            <span className={view.phase === "password" ? "current" : ""}>
              03 两步验证（如需）
            </span>
          </div>
          {error && (
            <div role="alert" className="alert error">
              {error}
            </div>
          )}
          {view.phase === "saved" && (
            <div className="alert success">
              登录会话已保存。
              {mode === "mock"
                ? "当前仍是模拟模式，不会自动开启真实充值。"
                : "可以回到账户页刷新钱包余额，再按预算创建订单。"}
            </div>
          )}
          {!["code", "password"].includes(view.phase) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send("start", {
                  phone,
                  ...(apiId ? { apiId: Number(apiId) } : {}),
                  ...(apiHash ? { apiHash } : {}),
                });
              }}
            >
              <label>
                手机号（含国家码）
                <input
                  type="tel"
                  autoComplete="tel"
                  placeholder="+65…"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                  disabled={waiting}
                />
              </label>
              <button
                type="button"
                className="text-button"
                onClick={() => setAdvanced(!advanced)}
              >
                {view.configured
                  ? "更改开发者应用配置"
                  : "首次配置：api_id 和 api_hash"}{" "}
                {advanced ? "−" : "+"}
              </button>
              {(!view.configured || advanced) && (
                <div className="credentials-box">
                  <p className="fine">
                    这两个值用来识别当前脚本，与机器人的归属无关。首次配置一次，之后手机号登录时无需重复填写。在
                    my.telegram.org 的 API development tools 获取。
                  </p>
                  <label>
                    API ID
                    <input
                      type="number"
                      min="1"
                      autoComplete="off"
                      value={apiId}
                      onChange={(e) => setApiId(e.target.value)}
                      required={!view.configured}
                      disabled={waiting}
                    />
                  </label>
                  <label>
                    API Hash
                    <input
                      type="password"
                      autoComplete="off"
                      value={apiHash}
                      onChange={(e) => setApiHash(e.target.value)}
                      required={!view.configured}
                      disabled={waiting}
                    />
                  </label>
                </div>
              )}
              <button className="primary" disabled={waiting}>
                {waiting ? "正在请求…" : "获取验证码"}
              </button>
            </form>
          )}
          {view.phase === "code" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send("code", { code });
              }}
            >
              <p className="fine">
                验证码已请求发送至 {view.phone}。
                {view.viaApp
                  ? "请在 Telegram 官方客户端查看登录通知。"
                  : "请按 Telegram 提示查看验证码，可能通过短信或其他渠道发送。"}
              </p>
              <label>
                Telegram 验证码
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{4,8}"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  disabled={waiting}
                />
              </label>
              <button className="primary" disabled={waiting}>
                {waiting ? "正在验证…" : "验证并登录"}
              </button>
            </form>
          )}
          {view.phase === "password" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send("password", { password });
              }}
            >
              <p className="fine">
                你的 Telegram 账号开启了两步验证，需要输入该账号的两步验证密码。
              </p>
              <label>
                两步验证密码
                <input
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={waiting}
                />
              </label>
              <button className="primary" disabled={waiting}>
                {waiting ? "正在验证…" : "完成登录"}
              </button>
            </form>
          )}
          {["code", "password"].includes(view.phase) && (
            <button
              className="text-button danger"
              disabled={waiting}
              onClick={() => void send("cancel", {})}
            >
              取消本次登录
            </button>
          )}
        </div>
        <aside className="connection-help">
          <h3>登录后会发生什么？</h3>
          <p>
            会话和开发者凭据仅保存在服务器的受限文件中，不返回给页面，不提交
            GitHub。
          </p>
          <p>
            验证码和两步验证密码只用于当前验证，不持久化。登录流程 5
            分钟后失效。
          </p>
          <p>登录成功不等于开启付款。部署的模拟／真实模式保持原设置。</p>
          <p>有未完成订单时不能更换账号，避免余额与订单归属混淆。</p>
          <p className="fine">请通过本机 SSH 隧道或 HTTPS 访问这个页面。</p>
        </aside>
      </div>
    </section>
  );
}
