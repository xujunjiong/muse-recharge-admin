import {
  ExecutionError,
  isTransientNetworkError,
} from "../execution-errors.js";
import { readFileSync } from "node:fs";
import { parseConfirmation, parseReceipt, parseIdr } from "../receipts.js";
import type { BotAdapter, InputOrder, Quote, Receipt } from "../types.js";
export type Button = {
  text: string;
  callback: boolean;
  click: () => Promise<unknown>;
};
export type Snapshot = { id: number; text: string; buttons: Button[] };
export type Transport = {
  read: () => Promise<Snapshot[]>;
  send: (text: string) => Promise<unknown>;
  close: () => Promise<void>;
};
export const TELEGRAM_OPTIONS = {
  connectionRetries: 2,
  requestRetries: 1,
  autoReconnect: true,
  floodSleepThreshold: 60,
};
type Ref = { id: number; text: string; maxId: number; startMaxId?: number };
export function isFreshResult(m: Snapshot, r: Ref) {
  return m.id > r.maxId || (m.id === r.id && m.text !== r.text);
}
/** 去掉按钮文本开头的 emoji/装饰符号，保留真正的按钮文案 */
export function stripButtonDecor(text: string) {
  return text.replace(/^[^\p{L}\p{N}]+/u, "");
}
/** 配额按钮的精确模式：开头必须是 "<qty>B"，可选 "FULL"，后跟破折号 */
export function quotaButtonPattern(qty: number) {
  return new RegExp(`^${qty}B(?:\\s+FULL)?\\s*[—–-]`);
}
export class TelegramAdapter implements BotAdapter {
  mode = "telegram" as const;
  submitted = new Set<string>();
  onReceipt?: (receipt: Receipt) => boolean;
  receiptOwner?: (messageId: number) => string | undefined;
  constructor(
    public transport: Transport,
    // 付款后等回执的超时：机器人交付是 30 次尝试逐次灌满，
    // 维护或排队时可能很久；2026-10-19 起改为 15 分钟。
    // 注意 wait() 内部仍按 45 秒封顶，只影响 result()。
    public timeout = 900000,
    public poll = 1500,
  ) {}
  static async connect(config: {
    apiId: number;
    apiHash: string;
    sessionFile: string;
    session?: string;
    expectedBotId: string;
  }) {
    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions/index.js");
    const client = new TelegramClient(
      new StringSession(
        config.session ?? readFileSync(config.sessionFile, "utf8").trim(),
      ),
      config.apiId,
      config.apiHash,
      TELEGRAM_OPTIONS,
    );
    client.setLogLevel("none" as any);
    await client.connect();
    if (!(await client.checkAuthorization())) {
      await client.disconnect();
      throw Error("Telegram 会话失效，请在服务器重新登录");
    }
    const bot: any = await client.getEntity("satudigitalbot");
    if (!bot.bot || String(bot.id) !== config.expectedBotId) {
      await client.disconnect();
      throw Error("目标机器人身份不匹配，禁止交易");
    }
    const transport: Transport = {
      read: async () => {
        const msgs = await client.getMessages(bot, { limit: 100 });
        const out: Snapshot[] = [];
        for (const m of msgs) {
          if (m.out || !m.message) continue;
          const sender = String(m.senderId || "");
          if (sender !== config.expectedBotId) continue;
          const bb = await m.getButtons();
          out.push({
            id: m.id,
            text: m.message,
            buttons: (bb || []).flat().map((b) => ({
              text: b.text,
              callback: !!b.data,
              click: () => b.click({}),
            })),
          });
        }
        return out.sort((a, b) => a.id - b.id);
      },
      send: (text) => client.sendMessage(bot, { message: text }),
      close: async () => {
        await client.disconnect();
      },
    };
    return new TelegramAdapter(transport);
  }
  private async read() {
    const snapshots = await this.transport.read();
    for (const m of snapshots) {
      const receipt = parseReceipt(m.text);
      if (receipt) this.onReceipt?.({ ...receipt, messageId: m.id });
    }
    return snapshots;
  }
  async pollReceipts() {
    await this.read();
  }
  async wait(
    predicate: (m: Snapshot) => boolean,
    before: Snapshot[],
    timeout = this.timeout,
    editedMessageId?: number,
  ) {
    const old = new Map(before.map((m) => [m.id, m.text]));
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const messages = await this.read();
      const maxId = Math.max(0, ...before.map((x) => x.id));
      const found = messages.filter(
        (m) =>
          (m.id > maxId || m.id === editedMessageId) &&
          old.get(m.id) !== m.text &&
          predicate(m),
      );
      if (found.length) return found.at(-1)!;
      for (const m of messages) {
        if (
          (m.id <= maxId && m.id !== editedMessageId) ||
          old.get(m.id) === m.text
        )
          continue;
        if (/INSUFFICIENT BALANCE/i.test(m.text))
          throw new ExecutionError("systemic", "钱包余额不足");
        if (/INVALID CODE|EXPIRED CODE/i.test(m.text))
          throw new ExecutionError(
            "local",
            "机器人明确拒绝邀请码：无效或过期，未付款",
          );
      }
      await new Promise((r) => setTimeout(r, this.poll));
    }
    throw Error("等待机器人回复超时；不会自动再次付款");
  }
  async action(
    fn: () => Promise<unknown>,
    predicate: (m: Snapshot) => boolean,
    editedMessageId?: number,
  ) {
    const before = await this.read();
    await fn();
    return this.wait(
      predicate,
      before,
      Math.min(45000, this.timeout),
      editedMessageId,
    );
  }
  button(m: Snapshot, re: RegExp) {
    const b = m.buttons.filter((b) => b.callback && re.test(b.text));
    if (b.length !== 1) throw Error("机器人菜单不匹配或按钮不唯一，已停止");
    return b[0];
  }
  /**
   * 配额按钮匹配：真实菜单的按钮常带 emoji/装饰前缀
   * （如 "🔥 30B FULL — Rp 40.500 / $2.26 (BEST VALUE)"），
   * 先去掉装饰再匹配 "^<qty>B [FULL] —"。
   * 注意不能用宽松的包含匹配："✏️ Custom Amount (1B - 30B)"
   * 里也含有 "1B"/"30B"，必须锚定在开头。
   */
  quotaButton(m: Snapshot, qty: number) {
    const re = quotaButtonPattern(qty);
    const b = m.buttons.filter(
      (b) => b.callback && re.test(stripButtonDecor(b.text)),
    );
    if (b.length !== 1) throw Error("机器人菜单不匹配或按钮不唯一，已停止");
    return b[0];
  }
  async entry() {
    return this.action(
      () => this.transport.send("/start"),
      (m) =>
        /Welcome to Satu Digital|Automatic MuseAI Token Filling|SEND YOUR MUSE ACCOUNT CODE/i.test(
          m.text,
        ),
    );
  }
  async balance() {
    let m = await this.entry();
    if (!/Welcome to Satu Digital/i.test(m.text)) {
      const all = await this.read();
      const menu = [...all]
        .reverse()
        .find((m) => m.buttons.some((b) => /Main Menu/.test(b.text)));
      if (!menu) throw Error("找不到安全的主菜单入口");
      m = await this.action(
        () => this.button(menu, /Main Menu/).click(),
        (m) => /Welcome to Satu Digital/i.test(m.text),
        menu.id,
      );
    }
    const match = m.text.match(/Your Wallet:\s*IDR\s*([\d.,]+)/);
    if (!match) throw Error("余额格式无法识别");
    return parseIdr(match[1]);
  }
  async prepare(order: InputOrder): Promise<Quote> {
    // 记录本单开始时的最大消息 id：机器人有时回执来得极快
    // （早于付款提交），result() 必须能看到这段时间内的回执。
    const startMaxId = Math.max(0, ...(await this.read()).map((x) => x.id));
    let m = await this.entry();
    if (/Welcome to Satu Digital/i.test(m.text))
      m = await this.action(
        () => this.button(m, /MuseAI Token\s*\(/).click(),
        (m) =>
          /Automatic MuseAI Token Filling|SEND YOUR MUSE ACCOUNT CODE/i.test(
            m.text,
          ),
        m.id,
      );
    if (/Automatic MuseAI Token Filling/i.test(m.text))
      m = await this.action(
        () => this.button(m, /Enter Muse Code/).click(),
        (m) => /SEND YOUR MUSE ACCOUNT CODE/i.test(m.text),
        m.id,
      );
    if (!/SEND YOUR MUSE ACCOUNT CODE/i.test(m.text))
      throw Error("未进入安全的邀请码输入状态");
    m = await this.action(
      () => this.transport.send(order.code),
      (m) =>
        /Muse Code(?: Detected)?:/i.test(m.text) &&
        new RegExp(`\\b${order.code}\\b`).test(m.text),
      m.id,
    );
    if (
      !m.buttons.some((b) =>
        quotaButtonPattern(order.quantity).test(stripButtonDecor(b.text)),
      )
    )
      m = await this.action(
        () => this.button(m, /Want More Quota/).click(),
        (m) => /Choose a Quota Package/i.test(m.text),
        m.id,
      );
    m = await this.action(
      () => this.quotaButton(m, order.quantity).click(),
      (m) => m.text.includes("MUSEAI TOKEN DELIVERY CONFIRMATION"),
      m.id,
    );
    const q = parseConfirmation(m.text);
    if (!q || q.code !== order.code || q.quantity !== order.quantity)
      throw new ExecutionError("systemic", "确认页的邀请码、数量或金额不匹配");
    if (q.cost > order.maxCost)
      throw new ExecutionError("local", "确认页报价超出费用上限，未付款");
    const balance = m.text.match(/Main Balance:\s*IDR\s*([\d.,]+)/);
    if (!balance) throw Error("确认页缺少钱包余额，禁止付款");
    if (parseIdr(balance[1]) < q.cost) throw Error("钱包余额不足");
    const all = await this.read();
    return {
      ...q,
      raw: m.text,
      ref: JSON.stringify({
        id: m.id,
        text: m.text,
        maxId: Math.max(...all.map((x) => x.id)),
        startMaxId,
      }),
    };
  }
  async submit(q: Quote, canSubmit?: () => boolean) {
    if (!q.ref || this.submitted.has(q.ref)) throw Error("拒绝重复提交付款");
    const r: Ref = JSON.parse(q.ref);
    const m = (await this.read()).find((m) => m.id === r.id);
    if (!m || m.text !== r.text) throw Error("确认页已变化，禁止付款");
    const current = parseConfirmation(m.text);
    if (
      !current ||
      current.code !== q.code ||
      current.quantity !== q.quantity ||
      current.cost !== q.cost
    )
      throw Error("付款确认内容不匹配");
    if (canSubmit && !canSubmit()) throw Error("执行权已失效，禁止付款");
    this.submitted.add(q.ref);
    await this.button(m, /Yes, Process Token/).click();
  }
  async result(q: Quote): Promise<Receipt> {
    const r: Ref = JSON.parse(q.ref!);
    // 回执可能早于付款提交到达（如机器人即时交付），用本单开始时的
    // startMaxId 而不是报价时的 maxId 做下界，避免漏掉早期回执。
    // 仍要求回执的邀请码与本单一致（worker 侧会再次校验）。
    const sinceId = r.startMaxId ?? r.maxId;
    const until = Date.now() + this.timeout;
    let readFailures = 0;
    while (Date.now() < until) {
      let messages: Snapshot[];
      try {
        messages = (await this.read()).filter(
          (m) => m.id > sinceId || (m.id === r.id && m.text !== r.text),
        );
      } catch (e) {
        if (!isTransientNetworkError(e)) throw e;
        // 付款已提交，等回执期间的瞬时网络抖动不能直接判失败：
        // 继续等到超时，超时才转人工核查。
        readFailures++;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(15000, this.poll * readFailures)),
        );
        continue;
      }
      readFailures = 0;
      for (const m of messages.reverse()) {
        const receipt = parseReceipt(m.text);
        if (receipt) {
          const observed = { ...receipt, messageId: m.id };
          const handled = this.onReceipt?.(observed);
          const owner = this.receiptOwner?.(m.id);
          if (owner && q.orderId && owner !== q.orderId) continue;
          if (receipt.code === q.code && (!this.onReceipt || handled))
            return observed;
          if (receipt.code !== q.code && handled) continue;
          throw new ExecutionError(
            "systemic",
            "机器人回执无法确认归属，暂停整个队列",
          );
        }
        // Non-receipt notices must be newer than the payment quote, or edit that quote.
        if (!isFreshResult(m, r)) continue;
        const noticeCode = m.text
          .match(/Invite Code:\s*([A-Z0-9]{6})(?![A-Z0-9])/i)?.[1]
          .toUpperCase();
        if (noticeCode && noticeCode !== q.code) continue;
        if (/INSUFFICIENT BALANCE/i.test(m.text))
          throw new ExecutionError(
            "systemic",
            "钱包余额不足，需核查本单是否扣款",
          );
        if (
          /FAILED|INSUFFICIENT BALANCE|INVALID CODE|EXPIRED CODE/i.test(m.text)
        )
          throw new ExecutionError(
            "uncertain",
            "机器人报告异常，需核对是否扣款或退款",
          );
        // 机器人明确说系统维护、交付延迟：不会再有回执，直接转人工核查，
        // 不必空等到超时。钱是否已扣、币是否会补发，都以 Telegram 为准。
        if (
          /temporarily delayed|periodic maintenance|under maintenance/i.test(
            m.text,
          )
        )
          throw new ExecutionError(
            "uncertain",
            "机器人系统维护中，交付延迟；请稍后在 Telegram 核对是否扣款/到账",
          );
      }
      await new Promise((resolve) => setTimeout(resolve, this.poll));
    }
    throw new ExecutionError(
      "uncertain",
      "付款后未收到最终回执，请核查，禁止自动重试",
    );
  }
  async close() {
    await this.transport.close();
  }
}
