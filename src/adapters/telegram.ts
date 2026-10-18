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
type Ref = { id: number; text: string; maxId: number };
export function isFreshResult(m: Snapshot, r: Ref) {
  return m.id > r.maxId || (m.id === r.id && m.text !== r.text);
}
export class TelegramAdapter implements BotAdapter {
  mode = "telegram" as const;
  submitted = new Set<string>();
  constructor(
    public transport: Transport,
    public timeout = 180000,
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
        const msgs = await client.getMessages(bot, { limit: 18 });
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
  async wait(
    predicate: (m: Snapshot) => boolean,
    before: Snapshot[],
    timeout = this.timeout,
    editedMessageId?: number,
  ) {
    const old = new Map(before.map((m) => [m.id, m.text]));
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const messages = await this.transport.read();
      const maxId = Math.max(0, ...before.map((x) => x.id));
      const found = messages.filter(
        (m) =>
          (m.id > maxId || m.id === editedMessageId) &&
          old.get(m.id) !== m.text &&
          predicate(m),
      );
      if (found.length) return found.at(-1)!;
      await new Promise((r) => setTimeout(r, this.poll));
    }
    throw Error("等待机器人回复超时；不会自动再次付款");
  }
  async action(
    fn: () => Promise<unknown>,
    predicate: (m: Snapshot) => boolean,
    editedMessageId?: number,
  ) {
    const before = await this.transport.read();
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
      const all = await this.transport.read();
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
        new RegExp(`^\\s*${order.quantity}B\\s*[—–-]`).test(b.text),
      )
    )
      m = await this.action(
        () => this.button(m, /Want More Quota/).click(),
        (m) => /Choose a Quota Package/i.test(m.text),
        m.id,
      );
    const re = new RegExp(`^\\s*${order.quantity}B(?:\\s+FULL)?\\s*[—–-]`);
    m = await this.action(
      () => this.button(m, re).click(),
      (m) => m.text.includes("MUSEAI TOKEN DELIVERY CONFIRMATION"),
      m.id,
    );
    const q = parseConfirmation(m.text);
    if (
      !q ||
      q.code !== order.code ||
      q.quantity !== order.quantity ||
      q.cost > order.maxCost
    )
      throw Error("确认页的邀请码、数量或金额不匹配");
    const balance = m.text.match(/Main Balance:\s*IDR\s*([\d.,]+)/);
    if (!balance) throw Error("确认页缺少钱包余额，禁止付款");
    if (parseIdr(balance[1]) < q.cost) throw Error("钱包余额不足");
    const all = await this.transport.read();
    return {
      ...q,
      raw: m.text,
      ref: JSON.stringify({
        id: m.id,
        text: m.text,
        maxId: Math.max(...all.map((x) => x.id)),
      }),
    };
  }
  async submit(q: Quote, canSubmit?: () => boolean) {
    if (!q.ref || this.submitted.has(q.ref)) throw Error("拒绝重复提交付款");
    const r: Ref = JSON.parse(q.ref);
    const m = (await this.transport.read()).find((m) => m.id === r.id);
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
    const until = Date.now() + this.timeout;
    while (Date.now() < until) {
      const messages = (await this.transport.read()).filter((m) =>
        isFreshResult(m, r),
      );
      for (const m of messages.reverse()) {
        const receipt = parseReceipt(m.text);
        if (receipt) return receipt;
        if (
          /FAILED|INSUFFICIENT BALANCE|INVALID CODE|EXPIRED CODE/i.test(m.text)
        )
          throw Error("机器人报告异常，需核对是否扣款或退款");
      }
      await new Promise((resolve) => setTimeout(resolve, this.poll));
    }
    throw Error("付款后未收到最终回执，请核查，禁止自动重试");
  }
  async close() {
    await this.transport.close();
  }
}
