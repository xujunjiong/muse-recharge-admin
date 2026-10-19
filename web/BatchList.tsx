import React from "react";
import type { Batch } from "../src/types.js";

function ResultCounts({ batch }: { batch: Batch }) {
  return (
    <span className="batch-counts">
      成功 {batch.counts.succeeded} / 失败 {batch.counts.failed} / 取消{" "}
      {batch.counts.cancelled}
    </span>
  );
}

export function BatchList({
  batches,
  busy,
  onAction,
  onReview,
}: {
  batches: Batch[];
  busy: boolean;
  onAction: (id: string, action: "pause" | "resume") => void;
  onReview: (id: string) => void;
}) {
  const active = batches.filter((b) => !b.finished);
  const history = batches.filter((b) => b.finished);
  if (!batches.length) return null;
  return (
    <section className="batch-panel" aria-label="批次管理">
      <h2 className="batch-heading">
        进行中批次 <span className="count">{active.length}</span>
      </h2>
      {active.length ? (
        <div className="batch-strip">
          {active.map((b) => (
            <div key={b.id}>
              <span className="batch-tag">批次 {b.id.slice(0, 8)}</span>
              <div className="batch-description">
                {b.counts.needs_review > 0 && (
                  <strong>
                    待核查 {b.counts.needs_review} 笔，请先人工处理
                  </strong>
                )}
                {b.counts.partial > 0 && (
                  <strong>部分交付 {b.counts.partial} 笔，请核对</strong>
                )}
                <span>
                  {b.paused ? b.reason || "已暂停" : "正在队列中执行"} · 待执行{" "}
                  {b.counts.queued} 笔
                </span>
                <ResultCounts batch={b} />
              </div>
              {b.counts.needs_review > 0 && (
                <button
                  className="small-button"
                  disabled={busy}
                  onClick={() => onReview(b.id)}
                >
                  去核查
                </button>
              )}
              {b.canResume && (
                <button
                  className="small-button"
                  disabled={busy}
                  onClick={() => onAction(b.id, "resume")}
                >
                  恢复执行
                </button>
              )}
              {!b.paused && b.counts.queued > 0 && (
                <button
                  className="small-button"
                  disabled={busy}
                  onClick={() => onAction(b.id, "pause")}
                >
                  暂停后续
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted batch-empty">暂无进行中的批次。</p>
      )}
      {history.length > 0 && (
        <details className="batch-history">
          <summary>历史批次（{history.length}）</summary>
          <div className="batch-strip">
            {history.map((b) => (
              <div key={b.id}>
                <span className="batch-tag">批次 {b.id.slice(0, 8)}</span>
                <ResultCounts batch={b} />
                <time dateTime={b.createdAt}>
                  {new Date(b.createdAt).toLocaleString("zh-CN", {
                    hour12: false,
                  })}
                </time>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
