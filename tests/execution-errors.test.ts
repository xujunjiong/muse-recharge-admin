import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure,
  isTransientNetworkError,
} from "../src/execution-errors.js";
test("classification distinguishes pre-payment rejections, uncertainty, and systemic failures", () => {
  for (const text of [
    "INVALID CODE",
    "EXPIRED CODE",
    "Request was unsuccessful 1 time(s)",
  ])
    assert.equal(classifyFailure(Error(text), false), "local");
  for (const text of ["付款后未收到最终回执", "机器人系统维护中，交付延迟"])
    assert.equal(classifyFailure(Error(text), true), "uncertain");
  for (const text of [
    "钱包余额不足",
    "INSUFFICIENT BALANCE",
    "AUTH_KEY_UNREGISTERED",
    "SESSION_REVOKED",
    "机器人菜单不匹配或按钮不唯一",
    "目标机器人身份不匹配",
    "付款确认内容不匹配",
    "执行权已失效",
    "unknown defect",
  ])
    assert.equal(classifyFailure(Error(text), false), "systemic");
  assert.equal(
    isTransientNetworkError(Error("SESSION_REVOKED network timeout")),
    false,
  );
});
