export type FailureKind = "local" | "uncertain" | "systemic";
export class ExecutionError extends Error {
  constructor(
    public kind: FailureKind,
    message: string,
  ) {
    super(message);
  }
}
export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e ?? "未知错误");
export function isSystemicError(e: unknown) {
  if (e instanceof ExecutionError) return e.kind === "systemic";
  return /余额不足|INSUFFICIENT BALANCE|会话失效|尚未连接|AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|FLOOD_WAIT|身份不匹配|菜单|按钮不唯一|确认页已变化|付款确认内容不匹配|执行[权锁].*失效|回执.*不匹配/i.test(
    errorMessage(e),
  );
}
export function isTransientNetworkError(e: unknown): boolean {
  if (e instanceof ExecutionError || isSystemicError(e)) return false;
  return /unsuccessful|timed out|timeout|network|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed/i.test(
    errorMessage(e),
  );
}
export function classifyFailure(
  e: unknown,
  paymentStarted: boolean,
): FailureKind {
  if (e instanceof ExecutionError) return e.kind;
  if (isSystemicError(e)) return "systemic";
  if (
    !paymentStarted &&
    (/INVALID CODE|EXPIRED CODE|无效.*码|邀请码.*过期/i.test(errorMessage(e)) ||
      isTransientNetworkError(e))
  )
    return "local";
  if (
    paymentStarted &&
    /未收到最终回执|等待回执超时|系统维护中|交付延迟|机器人报告异常/i.test(
      errorMessage(e),
    )
  )
    return "uncertain";
  return "systemic";
}
