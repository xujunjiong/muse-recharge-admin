import React, { useRef, useState } from "react";
import { PACKAGE_PRICES } from "../src/pricing.js";

type Draft = { code: string; quantity: number; key: string };
const money = (n: number) => new Intl.NumberFormat("en-US").format(n);

export function SingleRecharge({
  api,
  mode,
  walletBalance,
  onCreated,
}: {
  api: (path: string, body?: unknown) => Promise<any>;
  mode: "mock" | "telegram";
  walletBalance?: number | null;
  onCreated: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [allowRepeat, setAllowRepeat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const cost = PACKAGE_PRICES[draft?.quantity ?? quantity];
  const enough =
    typeof walletBalance === "number" &&
    Number.isSafeInteger(walletBalance) &&
    walletBalance >= cost;

  async function submit() {
    if (!draft || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await api("single-orders", { ...draft, allowRepeat });
      setDraft(null);
      setCode("");
      await onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section
      className="table-card single-recharge"
      aria-labelledby="single-title"
    >
      <div className="section-heading">
        <div>
          <h2 id="single-title">单笔充值</h2>
          <p>输入邀请码和充值量，无需导入文件。</p>
        </div>
      </div>
      {!draft && error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      <form
        className="tools single-tools"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          const normalized = code.trim().toUpperCase();
          if (!/^[A-Z0-9]{6}$/.test(normalized)) {
            setError("请输入六位字母或数字邀请码");
            return;
          }
          setAllowRepeat(false);
          setDraft({ code: normalized, quantity, key: crypto.randomUUID() });
        }}
      >
        <label htmlFor="single-code">
          邀请码
          <input
            id="single-code"
            value={code}
            placeholder="例如 1YG4RY"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label htmlFor="single-quantity">
          充值数量（B）
          <select
            id="single-quantity"
            value={quantity}
            disabled={busy}
            onChange={(e) => setQuantity(Number(e.target.value))}
          >
            {Object.keys(PACKAGE_PRICES).map((q) => (
              <option key={q} value={q}>
                {q}B
              </option>
            ))}
          </select>
        </label>
        <div className="single-estimate">
          <small>预计费用 / 扣款上限</small>
          <strong>Rp {money(PACKAGE_PRICES[quantity])}</strong>
        </div>
        <button type="submit" className="primary" disabled={busy}>
          创建订单
        </button>
      </form>
      <p className="single-hint muted">
        费用以机器人报价为准，超过上限不会付款。已有任务时自动排队。
      </p>
      {draft && (
        <div className="overlay">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="single-review-title"
            className="modal"
          >
            <p className="eyebrow">SINGLE ORDER REVIEW</p>
            <h2 id="single-review-title">确认单笔充值</h2>
            {error && (
              <div role="alert" className="alert error">
                {error}
              </div>
            )}
            <p className="muted">
              {mode === "mock"
                ? "当前是模拟模式，不会调用真实付款。"
                : "确认后将使用机器人钱包余额支付。"}
            </p>
            <div className="preview-stats">
              <div>
                <small>邀请码</small>
                <strong>{draft.code}</strong>
              </div>
              <div>
                <small>充值数量</small>
                <strong>{draft.quantity}B</strong>
              </div>
              <div>
                <small>扣款上限</small>
                <strong>Rp {money(cost)}</strong>
              </div>
            </div>
            {!enough && (
              <p role="alert" className="fine">
                余额未知或不足，请返回页面刷新余额后再提交。
              </p>
            )}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allowRepeat}
                disabled={busy}
                onChange={(e) => setAllowRepeat(e.target.checked)}
              />
              允许为历史已成功的目标再次充值（未决订单仍会阻止）
            </label>
            <div className="modal-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setError("");
                }}
              >
                返回检查
              </button>
              <button
                className="primary"
                disabled={busy || !enough}
                onClick={() => void submit()}
              >
                {busy ? "正在提交…" : "确认并开始执行"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
