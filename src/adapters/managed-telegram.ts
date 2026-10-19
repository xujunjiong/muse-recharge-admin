import { existsSync } from "node:fs";
import { TelegramAdapter } from "./telegram.js";
import { readSavedLogin } from "../telegram-login.js";
import type { BotAdapter, InputOrder, Quote, Receipt } from "../types.js";
/** Allows the admin page to boot before the first Telegram login. */
export class ManagedTelegram implements BotAdapter {
  mode = "telegram" as const;
  ready = false;
  onReceipt?: (receipt: Receipt) => boolean;
  receiptOwner?: (messageId: number) => string | undefined;
  private current: TelegramAdapter | null = null;
  constructor(
    private config: {
      loginFile: string;
      sessionFile: string;
      apiId: number;
      apiHash: string;
      expectedBotId: string;
    },
  ) {}
  async connect() {
    await this.close();
    const saved = readSavedLogin(this.config.loginFile);
    if (!saved && !existsSync(this.config.sessionFile))
      throw Error("请先在 Telegram 连接页登录");
    this.current = await TelegramAdapter.connect({
      ...this.config,
      ...(saved
        ? { apiId: saved.apiId, apiHash: saved.apiHash, session: saved.session }
        : {}),
    });
    this.current.onReceipt = (receipt) => this.onReceipt?.(receipt) ?? false;
    this.current.receiptOwner = (id) => this.receiptOwner?.(id);
    this.ready = true;
  }
  private get() {
    if (!this.current || !this.ready)
      throw Error("Telegram 尚未连接，请在连接页登录");
    return this.current;
  }
  async balance() {
    if (!this.ready) await this.connect();
    return this.get().balance();
  }
  async prepare(o: InputOrder) {
    return this.get().prepare(o);
  }
  async submit(q: Quote, guard?: () => boolean) {
    return this.get().submit(q, guard);
  }
  async result(q: Quote) {
    return this.get().result(q);
  }
  async pollReceipts() {
    await this.get().pollReceipts();
  }
  async close() {
    this.ready = false;
    const old = this.current;
    this.current = null;
    await old?.close();
  }
}
