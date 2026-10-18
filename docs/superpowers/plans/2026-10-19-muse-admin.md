# Muse Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现单用户 XLSX 导入和基于机器人回执的批量充值管理台。
**Architecture:** 同源网页、Node HTTP API、SQLite 持久化队列、独立机器人适配器。付费提交前持久化状态，未决付款禁止重试。
**Tech Stack:** Node.js 24、React/TypeScript（依赖可用时）、GramJS、SQLite、XLSX 解析库。
**Spec:** docs/superpowers/specs/2026-10-19-muse-admin-design.md

## Global Constraints
- 只使用用户授权的一次真实付款之外的非付费测试；本次开发不连接真实机器人。
- 单用户、串行队列、预算 IDR 整数、最大导入 1,000 条、5 MiB。
- 仅机器人匹配的最终回执算成功；部分交付和未知状态不得自动再次付款。
- 默认 localhost、SSH 隧道访问；凭据不进入源码和前端。
- 网络不可达不标记远程部署成功；依赖不可获取时保留可验证的本地实现并记录差异。

## Review Focus
- XLSX 压缩炸弹、公式与多邀请码歧义，Task 1 覆盖。
- 重复提交请求的内容变化和跨批次未决目标，Task 2 覆盖。
- 付款前后崩溃和取消/暂停竞争，Task 2 覆盖。
- 编辑旧消息导致历史回执误匹配，Task 3 覆盖。
- 登录攻击、CSRF 和敏感文件下载，Task 4 覆盖。

### Task 1: 导入与回执解析
**Files:** src/importer.*, src/receipts.*, tests/importer.test.*, tests/receipts.test.*
**Interfaces:** parseWorkbook(bytes) → validated rows; parseReceipt(text) → typed receipt.
- [ ] 写校验文本、重复、冲突、公式和异常文件测试，运行观察失败。
- [ ] 实现解析与错误报告；运行对应测试通过。
- [ ] 提交。

### Task 2: 数据库和安全执行器
**Files:** src/store.*, src/worker.*, src/adapters/mock.*, tests/worker.test.*
**Interfaces:** Store.createBatch(key, rows, budget), Worker.tick(), adapter.prepare/submit/result。
- [ ] 写幂等、预算、去重、暂停、付款不明、进程恢复的失败测试。
- [ ] 实现事务和单执行器锁、事件日志、模拟适配器。
- [ ] 全测试通过后提交。

### Task 3: Telegram 适配器和登录 CLI
**Files:** src/adapters/telegram.*, scripts/telegram-login.*, tests/telegram.test.*
**Interfaces:** 与 mock adapter 相同；GramJS dependency dynamic import，mock 不加载网络客户端。
- [ ] 写消息关联和回调序列测试，观察失败。
- [ ] 实现新消息/编辑消息观察、确认核验、唯一付款、无付费探测命令。
- [ ] 无真实网络下测试通过后提交；真实兼容性标记未验证。

### Task 4: HTTP 与页面
**Files:** src/server.*, public/*, tests/api.test.*
**Interfaces:** /api/login, /api/state, /api/import, /api/batches, pause/resume/cancel, export。
- [ ] 写未授权、会话、CSRF、文件边界、批次幂等接口测试，观察失败。
- [ ] 实现 API 与单用户管理页面，实时列表和预算确认。
- [ ] 运行 HTTP 测试和浏览器 UI 检查后提交。

### Task 5: 交付与部署
**Files:** README.md, .env.example, deploy/*, package.json, artifacts/*。
- [ ] 全套测试、语法/类型检查、模拟端到端运行。
- [ ] 检查交付包不含密钥、会话、node_modules 或业务数据。
- [ ] 完成全分支代码审阅与修复、记录限制。
- [ ] 输出源码压缩包和部署说明；尚未部署/尚未真实联调明确说明。
