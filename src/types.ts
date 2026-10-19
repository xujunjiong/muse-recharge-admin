export const QUANTITIES = [1, 5, 10, 15, 20, 30] as const;
export type Candidate = {
  row: number;
  code: string;
  quantity: number | null;
  maxCost: number | null;
  note: string;
  errors: string[];
};
export type InputOrder = {
  code: string;
  quantity: number;
  maxCost: number;
  note?: string;
};
export type Order = InputOrder & {
  id: string;
  batchId: string;
  status: string;
  actualQuantity: number | null;
  actualCost: number | null;
  message: string;
  createdAt: string;
  updatedAt: string;
  quote?: Quote;
  receipt?: Receipt;
};
export type Quote = {
  orderId?: string;
  code: string;
  quantity: number;
  cost: number;
  ref?: string;
  raw?: string;
};
export type Receipt = {
  messageId?: number;
  code: string;
  quantity: number;
  cost: number;
  balance: number;
  raw: string;
};
export interface BotAdapter {
  mode: "mock" | "telegram";
  ready?: boolean;
  balance(): Promise<number>;
  prepare(order: InputOrder): Promise<Quote>;
  submit(quote: Quote, canSubmit?: () => boolean): Promise<void>;
  result(quote: Quote): Promise<Receipt>;
  onReceipt?: (receipt: Receipt) => boolean;
  receiptOwner?: (messageId: number) => string | undefined;
  pollReceipts?(): Promise<void>;
  close?(): Promise<void>;
}
export function positiveInt(n: unknown): n is number {
  return Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= 1_000_000_000;
}

export type Batch = {
  id: string;
  budget: number;
  paused: number;
  reason: string;
  createdAt: string;
  finished: boolean;
  canResume: boolean;
  counts: Record<string, number>;
};
