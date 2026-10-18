import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { TelegramConnection } from "./TelegramConnection.js";
type Row = {
  row: number;
  code: string;
  quantity: number | null;
  maxCost: number | null;
  note: string;
  errors: string[];
};
const labels: Record<string, string> = {
  queued: "等待执行",
  preparing: "准备中",
  payment_submitting: "正在提交",
  processing: "交付中",
  succeeded: "交付成功",
  partial: "部分交付",
  failed: "已结束",
  needs_review: "待核查",
  cancelled: "已取消",
};
const prices: Record<number, number> = {
  1: 1700,
  5: 7500,
  10: 14000,
  15: 21000,
  20: 27000,
  30: 39000,
};
const money = (n: unknown) =>
  typeof n === "number" ? new Intl.NumberFormat("en-US").format(n) : "—";
function Icon({ name = "grid" }: { name?: string }) {
  const paths: Record<string, string> = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    upload: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6",
    clock: "M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    arrow: "M4 12h16m-6-6 6 6-6 6",
    wallet: "M3 6h17v15H3z M3 6V3h14v3 M15 11h6v5h-6z",
    check: "m5 12 4 4L19 6",
    logout: "M9 3H3v18h6 M8 12h13m-5-5 5 5-5 5",
    download: "M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4",
    refresh: "M20 7a9 9 0 1 0 1 9 M20 2v6h-6",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.grid} />
    </svg>
  );
}
function App() {
  const [logged, setLogged] = useState(false),
    [csrf, setCsrf] = useState(""),
    [password, setPassword] = useState(""),
    [state, setState] = useState<any>(null),
    [tab, setTab] = useState<"import" | "orders" | "telegram">("import"),
    [rows, setRows] = useState<Row[]>([]),
    [importId, setImportId] = useState(""),
    [fileName, setFileName] = useState(""),
    [selected, setSelected] = useState<Set<number>>(new Set()),
    [quantity, setQuantity] = useState(1),
    [maxCost, setMaxCost] = useState(1700),
    [budget, setBudget] = useState(0),
    [preview, setPreview] = useState(false),
    [allowRepeat, setAllowRepeat] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [detail, setDetail] = useState<any>(null),
    [reviewText, setReviewText] = useState("");
  const input = useRef<HTMLInputElement>(null),
    requestKey = useRef("");
  async function api(path: string, body?: unknown, raw = false) {
    const res = await fetch("/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "x-csrf-token": csrf }),
        ...(!raw && body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body:
        body === undefined
          ? undefined
          : raw
            ? (body as BodyInit)
            : JSON.stringify(body),
    });
    const data = await res.json();
    if (res.status === 401) {
      setLogged(false);
    }
    if (!res.ok) throw Error(data.error || "请求失败");
    return data;
  }
  async function refresh() {
    try {
      setState(await api("state"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void (async () => {
      try {
        const r = await api("session");
        setCsrf(r.csrf);
        setLogged(true);
      } catch {}
    })();
  }, []);
  useEffect(() => {
    if (!logged) return;
    void refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 2500);
    return () => clearInterval(t);
  }, [logged, csrf]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setError("请上传 .xlsx 文件");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("文件不能超过 5 MiB");
      return;
    }
    await action(async () => {
      const r = await api("import", file, true);
      setRows(r.rows);
      setImportId(r.id);
      setFileName(file.name);
      setSelected(
        new Set(
          r.rows.filter((r: Row) => !r.errors.length).map((r: Row) => r.row),
        ),
      );
      setNotice(`导入完成：${r.rows.length} 行，请核对后下单`);
      setTab("import");
    });
  }
  const valid = rows.filter((r) => !r.errors.length),
    chosen = rows.filter((r) => selected.has(r.row) && !r.errors.length),
    total = chosen.length * maxCost;
  function toggle(n: number) {
    setSelected((old) => {
      const next = new Set(old);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  }
  function openPreview() {
    setError("");
    if (!chosen.length) {
      setError("请先选择有效账户");
      return;
    }
    setBudget(total);
    setAllowRepeat(false);
    requestKey.current = crypto.randomUUID();
    setPreview(true);
  }
  const orders = state?.orders || [],
    visibleOrders = orders.filter(
      (o: any) =>
        (filter === "all" || o.status === filter) &&
        o.code.includes(search.trim().toUpperCase()),
    );
  const succeeded = orders.filter((o: any) => o.status === "succeeded").length,
    charged = orders.reduce((n: number, o: any) => n + (o.actualCost || 0), 0),
    pending = orders.filter((o: any) =>
      ["queued", "preparing", "payment_submitting", "processing"].includes(
        o.status,
      ),
    ).length;
  if (!logged)
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="brand-mark">m</div>
          <p className="eyebrow">MUSE OPERATIONS</p>
          <h1>欢迎回来。</h1>
          <p className="muted">登录你的批量充值工作台</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const r = await api("login", { password });
                setCsrf(r.csrf);
                setLogged(true);
                setPassword("");
              });
            }}
          >
            <label>
              管理台密码
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {error && (
              <div role="alert" className="alert error">
                {error}
              </div>
            )}
            <button className="primary" disabled={busy}>
              登录工作台 <Icon name="arrow" />
            </button>
          </form>
          <p className="fine">单用户 · 私有管理 · 预算受控</p>
        </section>
      </main>
    );
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">m</span>
          <div>
            <strong>
              muse<span className="brand-dot">.</span>
            </strong>
            <small>充值工作台</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          <button
            className={tab === "import" ? "active" : ""}
            onClick={() => setTab("import")}
          >
            <Icon />
            账户与导入<span>{rows.length || "+"}</span>
          </button>
          <button
            className={tab === "orders" ? "active" : ""}
            onClick={() => setTab("orders")}
          >
            <Icon name="clock" />
            订单记录<span>{orders.length}</span>
          </button>
          <button
            className={tab === "telegram" ? "active" : ""}
            onClick={() => setTab("telegram")}
          >
            <Icon name="check" />
            Telegram 连接
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="green-dot" />
          <strong>逐笔执行，安心交付</strong>
          <p>每笔付款前核对目标与预算，收到最终回执后再继续。</p>
        </div>
        <div className="sidebar-bottom">
          <div className="avatar">X</div>
          <div>
            <strong>个人工作空间</strong>
            <small>管理员</small>
          </div>
          <button
            className="icon-button"
            aria-label="退出登录"
            onClick={() =>
              void action(async () => {
                await api("logout", {});
                setLogged(false);
              })
            }
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <span>/</span>{" "}
            <strong>
              {tab === "import"
                ? "账户与导入"
                : tab === "telegram"
                  ? "Telegram 连接"
                  : "订单记录"}
            </strong>
          </div>
          <div className={"mode " + (state?.mode === "mock" ? "mock" : "live")}>
            <span className="status-dot" />
            {state?.mode === "mock" ? "模拟模式 · 不会扣款" : "真实充值模式"}
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">YOUR TOKENS, ORGANIZED.</p>
              <h1>
                {tab === "import"
                  ? "把重复操作，交给队列。"
                  : tab === "telegram"
                    ? "在页面上，连接你的账号。"
                    : "每一笔交付，都有记录。"}
              </h1>
              <p className="muted">
                {tab === "import"
                  ? "导入账户，设好预算。剩下的，有序完成。"
                  : tab === "telegram"
                    ? "首次配置一次，之后用手机号和验证码登录。"
                    : "查看充值进度、实际扣款与机器人最终回执。"}
              </p>
            </div>
            <a className="button secondary" href="/api/export">
              <Icon name="download" />
              导出记录
            </a>
          </div>
          {error && (
            <div role="alert" className="alert error">
              {error}
              <button onClick={() => setError("")} aria-label="关闭错误">
                ×
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="alert success">
              {notice}
              <button onClick={() => setNotice("")} aria-label="关闭提示">
                ×
              </button>
            </div>
          )}
          <div className="stats">
            <section className="stat wallet-stat">
              <div className="stat-label">
                {state?.mode === "mock" ? "模拟钱包余额" : "机器人钱包余额"}
                <Icon name="wallet" />
              </div>
              <div className="stat-value">
                <small>Rp</small> {money(state?.wallet?.balance)}
              </div>
              <div className="stat-foot">
                <span>
                  {state?.wallet?.at
                    ? "更新于 " +
                      new Date(state.wallet.at).toLocaleTimeString("zh-CN")
                    : "尚未查询"}
                </span>
                <button
                  className="text-button"
                  disabled={busy || state?.busy}
                  onClick={() => void action(() => api("refresh-balance", {}))}
                >
                  <Icon name="refresh" />
                  刷新
                </button>
              </div>
            </section>
            <section className="stat">
              <div className="stat-label">
                待处理订单
                <Icon name="clock" />
              </div>
              <div className="stat-value">
                {pending}
                <small> 笔</small>
              </div>
              <div className="stat-foot">
                {state?.busy ? (
                  <>
                    <span className="status-dot" />
                    正在逐笔处理中
                  </>
                ) : (
                  "队列就绪，等待任务"
                )}
              </div>
            </section>
            <section className="stat">
              <div className="stat-label">
                交付成功
                <Icon name="check" />
              </div>
              <div className="stat-value">
                {succeeded}
                <small> 笔</small>
              </div>
              <div className="stat-foot">依据机器人的最终回执</div>
            </section>
            <section className="stat">
              <div className="stat-label">
                累计扣款
                <Icon name="wallet" />
              </div>
              <div className="stat-value">
                <small>Rp</small> {money(charged)}
              </div>
              <div className="stat-foot">
                {state?.mode === "mock"
                  ? "模拟数据，不代表真实付款"
                  : "仅统计已记录的实际扣款"}
              </div>
            </section>
          </div>
          {state?.batches?.some(
            (b: any) =>
              b.paused ||
              orders.some(
                (o: any) =>
                  o.batchId === b.id &&
                  [
                    "queued",
                    "preparing",
                    "processing",
                    "payment_submitting",
                  ].includes(o.status),
              ),
          ) && (
            <div className="batch-strip">
              {state.batches
                .filter(
                  (b: any) =>
                    b.paused ||
                    orders.some(
                      (o: any) =>
                        o.batchId === b.id &&
                        [
                          "queued",
                          "preparing",
                          "processing",
                          "payment_submitting",
                        ].includes(o.status),
                    ),
                )
                .map((b: any) => (
                  <div key={b.id}>
                    <span className="batch-tag">批次 {b.id.slice(0, 8)}</span>
                    <span>{b.paused ? b.reason : "正在队列中执行"}</span>
                    <button
                      className="small-button"
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          api(
                            `batches/${b.id}/${b.paused ? "resume" : "pause"}`,
                            {},
                          ),
                        )
                      }
                    >
                      {b.paused ? "恢复执行" : "暂停后续"}
                    </button>
                  </div>
                ))}
            </div>
          )}
          {tab === "telegram" ? (
            <TelegramConnection
              value={state?.telegramLogin || null}
              mode={state?.mode || "mock"}
              api={api}
              refresh={refresh}
            />
          ) : tab === "import" ? (
            <>
              <section
                className="upload-card"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void upload(e.dataTransfer.files[0]);
                }}
              >
                <div className="upload-symbol">
                  <Icon name="upload" />
                </div>
                <div className="upload-copy">
                  <h2>从 Excel 开始</h2>
                  <p>拖入 .xlsx，或点击导入。支持邀请码与完整邀请文本。</p>
                  <div className="upload-hints">
                    <span>最多 1,000 行</span>
                    <span>5 MiB 以内</span>
                    <a href="/api/template">下载导入模板 ↗</a>
                  </div>
                </div>
                <input
                  ref={input}
                  type="file"
                  accept=".xlsx"
                  hidden
                  onChange={(e) => {
                    void upload(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => input.current?.click()}
                >
                  <Icon name="upload" />
                  {busy ? "正在处理…" : "导入 XLSX"}
                </button>
              </section>
              <section className="table-card">
                <div className="section-heading">
                  <div>
                    <h2>
                      账户清单 <span className="count">{rows.length}</span>
                    </h2>
                    <p>{fileName || "导入后先预览，确认前不会提交任何订单"}</p>
                  </div>
                  {rows.length > 0 && (
                    <span className="valid-note">
                      {valid.length} 条有效 · {rows.length - valid.length}{" "}
                      条需检查
                    </span>
                  )}
                </div>
                <div className="tools">
                  <label>
                    统一充值量
                    <select
                      value={quantity}
                      onChange={(e) => {
                        const q = Number(e.target.value);
                        setQuantity(q);
                        setMaxCost(prices[q]);
                      }}
                    >
                      {Object.keys(prices).map((q) => (
                        <option value={q} key={q}>
                          {q}B token
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    单笔扣款上限（IDR）
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={maxCost}
                      onChange={(e) => setMaxCost(Number(e.target.value))}
                    />
                  </label>
                  <span className="tools-note">
                    以上设置将应用到本次选中账户，覆盖表格内的充值量与上限。
                  </span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <input
                            aria-label="全选有效账户"
                            type="checkbox"
                            checked={
                              valid.length > 0 &&
                              valid.every((r) => selected.has(r.row))
                            }
                            onChange={(e) =>
                              setSelected(
                                e.target.checked
                                  ? new Set(valid.map((r) => r.row))
                                  : new Set(),
                              )
                            }
                          />
                        </th>
                        <th>来源行</th>
                        <th>Muse 邀请码</th>
                        <th>表格充值量</th>
                        <th>表格费用上限</th>
                        <th>校验结果</th>
                        <th>备注</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!rows.length ? (
                        <tr>
                          <td colSpan={7}>
                            <div className="empty">
                              <div className="empty-icon">
                                <Icon name="upload" />
                              </div>
                              <strong>你的账户，即将在这里就位</strong>
                              <p>导入一份 Excel，开始第一批充值。</p>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        rows.map((r) => (
                          <tr
                            key={r.row}
                            className={
                              selected.has(r.row) ? "selected-row" : ""
                            }
                          >
                            <td>
                              <input
                                aria-label={`选择第 ${r.row} 行`}
                                type="checkbox"
                                disabled={!!r.errors.length}
                                checked={selected.has(r.row)}
                                onChange={() => toggle(r.row)}
                              />
                            </td>
                            <td className="muted">
                              {String(r.row).padStart(2, "0")}
                            </td>
                            <td>
                              <code>{r.code || "—"}</code>
                            </td>
                            <td>
                              {r.quantity ? r.quantity + "B" : "使用统一设置"}
                            </td>
                            <td>
                              {r.maxCost
                                ? "Rp " + money(r.maxCost)
                                : "使用统一设置"}
                            </td>
                            <td>
                              <span
                                className={
                                  "badge " +
                                  (r.errors.length
                                    ? "needs_review"
                                    : "succeeded")
                                }
                              >
                                {r.errors.length
                                  ? r.errors.join("；")
                                  : "校验通过"}
                              </span>
                            </td>
                            <td className="note-cell">{r.note || "—"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                <footer className="table-footer">
                  <span>
                    已选 <strong>{chosen.length}</strong> 个账户{" "}
                    <span className="sep">|</span> 总量{" "}
                    <strong>{chosen.length * quantity}B</strong>
                    <span className="sep">|</span> 费用上限{" "}
                    <strong>Rp {money(total)}</strong>
                  </span>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !chosen.length ||
                      !Number.isSafeInteger(maxCost) ||
                      maxCost <= 0
                    }
                    onClick={openPreview}
                  >
                    批量下单 <Icon name="arrow" />
                  </button>
                </footer>
              </section>
            </>
          ) : (
            <section className="table-card">
              <div className="section-heading">
                <div>
                  <h2>
                    全部订单 <span className="count">{orders.length}</span>
                  </h2>
                  <p>处理中不会重复提交；结果不明时自动暂停。</p>
                </div>
                <div className="filters">
                  <input
                    aria-label="搜索邀请码"
                    placeholder="搜索邀请码…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <select
                    aria-label="筛选状态"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">所有状态</option>
                    {Object.entries(labels).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>邀请码</th>
                      <th>目标量</th>
                      <th>订单状态</th>
                      <th>实际交付</th>
                      <th>实际扣款</th>
                      <th>更新时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!visibleOrders.length ? (
                      <tr>
                        <td colSpan={7}>
                          <div className="empty">
                            <Icon name="clock" />
                            <strong>这里还没有订单记录</strong>
                            <p>提交批次后，进度与回执会自动出现在这里。</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      visibleOrders.map((o: any) => (
                        <tr key={o.id}>
                          <td>
                            <code>{o.code}</code>
                            <small className="row-note">{o.note}</small>
                          </td>
                          <td>{o.quantity}B</td>
                          <td>
                            <span className={"badge " + o.status}>
                              {labels[o.status] || o.status}
                            </span>
                          </td>
                          <td>
                            {o.actualQuantity === null
                              ? "—"
                              : o.actualQuantity + "B"}
                          </td>
                          <td>
                            {o.actualCost === null
                              ? "—"
                              : "Rp " + money(o.actualCost)}
                          </td>
                          <td className="muted">
                            {new Date(o.updatedAt).toLocaleString("zh-CN")}
                          </td>
                          <td>
                            <button
                              className="text-button"
                              onClick={() =>
                                void action(async () => {
                                  setDetail(await api("orders/" + o.id));
                                  setReviewText("");
                                })
                              }
                            >
                              详情
                            </button>
                            {["queued", "preparing"].includes(o.status) && (
                              <button
                                className="text-button danger"
                                onClick={() =>
                                  void action(() =>
                                    api(`orders/${o.id}/cancel`, {}),
                                  )
                                }
                              >
                                取消
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <div className="page-foot">
            <span>
              <span className="green-dot" />
              所有操作由服务器持久化记录
            </span>
            <span>Muse Operations · 个人管理台</span>
          </div>
        </div>
      </main>
      {preview && (
        <div className="overlay">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-title"
            className="modal"
          >
            <p className="eyebrow">BATCH REVIEW</p>
            <h2 id="preview-title">确认这一批充值</h2>
            {error && (
              <div role="alert" className="alert error">
                {error}
              </div>
            )}
            <p className="muted">
              {state?.mode === "mock"
                ? "当前是模拟模式，不会调用真实付款。"
                : "确认后将使用机器人钱包余额支付。"}
            </p>
            <div className="preview-stats">
              <div>
                <small>选中账户</small>
                <strong>{chosen.length} 个</strong>
              </div>
              <div>
                <small>总充值量</small>
                <strong>{chosen.length * quantity}B</strong>
              </div>
              <div>
                <small>单笔上限</small>
                <strong>Rp {money(maxCost)}</strong>
              </div>
            </div>
            <label>
              整批扣款上限（IDR）
              <input
                type="number"
                min={total}
                step="1"
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
              />
            </label>
            <p className="fine">
              必须至少为 Rp {money(total)}。逐笔核对实际报价，超出限制会暂停。
            </p>
            <div className="code-preview">
              {chosen.slice(0, 12).map((r) => (
                <code key={r.row}>{r.code}</code>
              ))}
              {chosen.length > 12 && <span>另 {chosen.length - 12} 个</span>}
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allowRepeat}
                onChange={(e) => setAllowRepeat(e.target.checked)}
              />
              允许为历史已成功的目标再次充值（未决订单仍会阻止）
            </label>
            <div className="modal-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setPreview(false)}
              >
                返回检查
              </button>
              <button
                className="primary"
                disabled={
                  busy || budget < total || !Number.isSafeInteger(budget)
                }
                onClick={() =>
                  void action(async () => {
                    await api("batches", {
                      key: requestKey.current,
                      importId,
                      rows: chosen.map((r) => r.row),
                      quantity,
                      maxCost,
                      budget,
                      allowRepeat,
                    });
                    setPreview(false);
                    setTab("orders");
                    setSelected(new Set());
                    setNotice("批次已创建，后台将逐笔执行。");
                  })
                }
              >
                {busy ? "正在提交…" : "确认并开始执行"}
                <Icon name="arrow" />
              </button>
            </div>
          </section>
        </div>
      )}
      {detail && (
        <div className="overlay">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            className="modal detail"
          >
            <div className="section-heading">
              <h2 id="detail-title">订单详情 · {detail.order.code}</h2>
              <button
                className="icon-button"
                aria-label="关闭详情"
                onClick={() => setDetail(null)}
              >
                ×
              </button>
            </div>
            <span className={"badge " + detail.order.status}>
              {labels[detail.order.status]}
            </span>
            <p>{detail.order.message}</p>
            <div className="timeline">
              {detail.events.map((e: any) => (
                <div key={e.id}>
                  <small>{new Date(e.createdAt).toLocaleString("zh-CN")}</small>
                  <strong>{labels[e.status]}</strong>
                  <p>{e.message}</p>
                </div>
              ))}
            </div>
            {detail.order.receipt && (
              <>
                <h3>最终机器人回执</h3>
                <pre>{detail.order.receipt.raw}</pre>
              </>
            )}
            {detail.order.status === "needs_review" && (
              <div className="review">
                <h3>核查结果</h3>
                {error && (
                  <div role="alert" className="alert error">
                    {error}
                  </div>
                )}
                <p className="fine">
                  先在 Telegram 核对，不能因超时直接认定未扣款。
                </p>
                <textarea
                  aria-label="补录机器人最终回执"
                  placeholder="如已交付，粘贴机器人完整的最终成功回执"
                  value={reviewText}
                  onChange={(e) => setReviewText(e.target.value)}
                />
                <div className="modal-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "你是否已在机器人核实：没有扣款，或已全额退款？此操作不会重新付款。",
                        )
                      )
                        void action(async () => {
                          await api(`orders/${detail.order.id}/resolve`, {
                            resolution: "not_charged",
                          });
                          setDetail(null);
                        });
                    }}
                  >
                    确认未扣款／已退款
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !reviewText}
                    onClick={() =>
                      void action(async () => {
                        await api(`orders/${detail.order.id}/resolve`, {
                          resolution: "record_receipt",
                          receipt: reviewText,
                        });
                        setDetail(null);
                      })
                    }
                  >
                    校验并保存回执
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
