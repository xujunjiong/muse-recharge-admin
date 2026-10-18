# Muse Recharge Admin

个人使用的 Muse token 批量充值管理台。导入 XLSX → 预览及选择账户 → 设置数量与预算 → 创建批次 → 后台串行操作 Satu Digital → 保存最终机器人回执。

默认模拟模式，**不会连接 Telegram 或真实扣款**。真实 GramJS 兼容性尚未用实际账号验证；本项目的测试使用明确隔离的模拟适配器与模拟 Telegram 菜单。之前人工网页测试不代表本脚本已真实联调。

## 功能

- 管理员登录、HttpOnly 会话、CSRF 与来源检查，默认只监听 localhost。
- XLSX 文件与解压大小限制、公式拒绝、邀请码解析、冲突检测与去重。
- 批次预览、单笔和整批预算、明确允许历史目标再次充值。
- SQLite 持久化队列、执行锁、付款前记录；中途重启不盲目再次付款。
- 进度、暂停后续、恢复、未付款取消、异常核查、原始回执和 CSV 导出。
- 单 Telegram 用户会话串行执行；不登录 Muse、不核验 Muse 账户余额。

## 环境

Node.js **24 LTS 或以上**、npm。Ubuntu 22.04 自带的旧版 Node.js 不满足要求；先按 Node.js 官方渠道安装 Node.js 24，再继续。Node 内置 SQLite 由 Node.js 提供。系统服务示例使用 `/usr/bin/node`，若安装在别处必须修改 ExecStart。不要以 root 运行应用。

```bash
npm ci
npm run build
npm run setup
npm start
```

`npm run setup` 在本地交互终端设置至少 12 位的管理台密码，并写入受限 `.env`。不要在录屏、共享终端或开启命令输出录制时输入登录秘密。`.env` 不存在时服务不会使用默认密码。

通过 SSH 隧道访问东京实例：

```bash
ssh -i /你的私钥路径 -L 3000:127.0.0.1:3000 ubuntu@你的服务器地址
```

保持 SSH 窗口运行，然后在本机浏览器打开 `http://127.0.0.1:3000`。无需开放公网 3000 端口。域名和手机直接访问不包含在默认部署中；如需使用，应配置 HTTPS、APP_ORIGIN 与 COOKIE_SECURE。

## XLSX 格式

第一行是列名，读取首个工作表。最多 1,000 行数据、文件上限 5 MiB、解压内容总量上限 20 MiB。

| 列名            | 英文别名     | 内容                                  |
| --------------- | ------------ | ------------------------------------- |
| 邀请码          | invite_code  | 六位字母数字，或使用邀请文本列        |
| 邀请文本        | invite_text  | 完整中文邀请文本或 `Invite code: ...` |
| 充值量B         | quantity_b   | 可空；支持 1、5、10、15、20、30       |
| 单笔费用上限IDR | max_cost_idr | 可空；正整数 IDR                      |
| 备注            | note         | 可空，不发送给机器人                  |

邀请码和邀请文本至少一列。显式邀请码与文本不一致、多个不同邀请码、公式或重复行会提示错误，不参与下单。页面的统一数量与上限会覆盖本次选中行的表格设置；确认页显示最终授权。

可从登录后的页面下载空白 XLSX 模板。上传只创建候选清单，不会自动下单。

价格以机器人确认页为准。初始参考价：1B 为 Rp 1,700；5B 为 Rp 7,500；10B 为 Rp 14,000；15B 为 Rp 21,000；20B 为 Rp 27,000；30B 为 Rp 39,000。界面提供费用上限，不能保证价格不变。选择前建议核对机器人报价。

## Telegram 首次登录

1. 使用自己的 Telegram 开发者应用凭据。在服务器的 `.env` 中填写 `TELEGRAM_API_ID` 与 `TELEGRAM_API_HASH`。
2. 运行以下命令，在服务器终端本人输入手机号、验证码及可能的两步验证密码。程序不打印或上传会话内容。

```bash
npm run login:telegram
```

会话保存在 `data/telegram.session`，权限 0600。它代表已登录账号，可访问该账号能力，必须仅允许服务用户读取。可在 Telegram 的设备管理中撤销此会话。程序不从浏览器提取会话，也不要求你将验证码发到聊天。

3. 使用一个你自己的六位邀请码运行不扣款探测：

```bash
npm run probe:telegram -- ABC123
```

`ABC123` 是占位符，替换成自己的邀请码。探测发送邀请码、选择 1B、读取确认页，**不点击最终付款**。实际报价超过 Rp 1,700 时探测会停止；不会为测试调整预算。测试后在机器人取消确认页。若菜单不匹配，停止并修订适配器，不得猜测按钮。

4. 先停止模拟服务，将旧模拟数据库保留为单独文件，然后修改 `.env`：

```dotenv
BOT_MODE=telegram
LIVE_PAYMENTS_ENABLED=YES
DATABASE_FILE=data/live.sqlite
```

重启服务，刷新真实钱包余额，先只导入一个授权小额账户进行验证，再使用批次操作。不要让模拟与真实模式共用数据库；业务数据在模式切换时不会自动迁移。

当前 `telegram` npm 包为锁定的 GramJS 兼容实现。安装输出显示该包已归档；因此真实适配器作为待联调模块提供，不应跳过不付款探测和小额验证。后续可独立替换通信库，订单安全逻辑不依赖具体库。

## 扣款与异常

- 一个批次请求 ID 对应一次创建；双击确认不重复生成。
- 一个邀请码不能同时有两个未决订单；历史成功目标默认阻止再次充值。
- 只有邀请码、实际交付量和费用均匹配的最终成功回执才标记成功。
- 部分交付单独标记，不自动补单；批次暂停。
- 付款后超时、网络断开或进程重启：进入“待核查”，阻止新的付款。**不保证跨 Telegram 的 exactly-once，但不会自动重试不确定付款。**
- 在订单详情中粘贴真实最终回执，或在人工核对确实未扣款/已全额退款后确认结束，再恢复批次。核查本身不会再次付款。
- 暂停只阻止后续付款，不能撤回已提交订单。
- 运行批次期间不要在其他 Telegram 客户端手动操作同一机器人，以免菜单状态变化。若识别不到预期页面，执行器会停止。

## 生产部署（AWS Lightsail）

本项目未自动连接或修改用户服务器；在你能登录的 AWS 网页终端或 SSH 中部署。示例路径为 `/opt/muse-admin`。

1. 上传/克隆本仓库，创建专用服务用户 `museadmin`，把应用和 data 目录交给该用户；不要覆盖其他业务。
2. 安装 Node.js 24；以服务用户执行 `npm ci`、`npm run build` 和 `npm run setup`。前端可先在本地构建后上传，减少 1GB 实例构建开销。
3. 以同一服务用户完成 Telegram 登录和不扣款探测。确保 `.env`、会话与数据库不可被其他用户读取。
4. 选择并配置模拟或真实模式。复制 `deploy/muse-admin.service` 到 systemd 服务目录，核对 Node 路径、用户和 WorkingDirectory 后启动。

```bash
sudo cp deploy/muse-admin.service /etc/systemd/system/muse-admin.service
sudo systemctl daemon-reload
sudo systemctl enable --now muse-admin
sudo systemctl status muse-admin
# 查看运行状态；日志不应出现登录凭据
sudo journalctl -u muse-admin -n 50
```

应用启动不会自动登录或创建 Telegram 账号。真实模式如未配置 `LIVE_PAYMENTS_ENABLED=YES` 会拒绝启动。已有未结束批次会在启动时按持久化状态恢复；因此上线真实服务前应先检查数据库和队列。

服务停止会等待已提交订单的回执，systemd 最多等待 240 秒；如被强制终止，重启后该订单进入待核查。

## 开发验证

```bash
npm test
npm run check
npm run build
```

测试使用内存数据库或专用临时数据库，不连接 Telegram、不扣款。前端浏览器测试需另备 Playwright 浏览器环境。

## 文件与备份

源码可上传 GitHub。`.env`、`data/`、SSH 私钥、会话文件和本地测试数据均在忽略列表中；发布前仍应检查 `git ls-files`。SSH 私钥不属于本项目。

业务数据库包含邀请码与交易回执，应当私密保存。备份 SQLite 时使用 SQLite 一致性备份方式或停止服务后复制，不能只复制活跃 WAL 数据库的主文件而忽略事务。Telegram 会话需单独安全保存，不提供网页下载。

详细验收边界见 [docs/verification.md](docs/verification.md)。执行器仅支持单机本地 SQLite；锁会检查旧进程是否仍存活，不能通过多实例或共享数据库提高并发。
