import type { Quote, Receipt } from "./types.js";
export function parseIdr(s: string): number {
  if (!/^(?:\d+|\d{1,3}(?:[.,]\d{3})+)$/.test(s))
    throw Error("无法识别 IDR 整数金额");
  const n = Number(s.replace(/[.,]/g, ""));
  if (!Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000)
    throw Error("金额超出限制");
  return n;
}
const amount = (s: string, re: RegExp) => {
  const m = s.match(re);
  return m ? parseIdr(m[1]) : null;
};
export function parseConfirmation(text: string): Quote | null {
  if (!text.includes("MUSEAI TOKEN DELIVERY CONFIRMATION")) return null;
  const code = text
    .match(/Invite Code:\s*([A-Z0-9]{6})(?![A-Z0-9])/i)?.[1]
    .toUpperCase();
  const q = text.match(/Fill Target:\s*(\d+(?:\.\d+)?)B\s*Tokens/i)?.[1];
  const cost = amount(text, /Total Main Balance Cost:\s*Rp\s*([\d.,]+)/i);
  return code && q && cost !== null
    ? { code, quantity: Number(q), cost }
    : null;
}
export function parseReceipt(text: string): Receipt | null {
  if (!text.includes("TOKEN DELIVERED SUCCESSFULLY!")) return null;
  const code = text
    .match(/Invite Code:\s*([A-Z0-9]{6})(?![A-Z0-9])/i)?.[1]
    .toUpperCase();
  const q = text.match(
    /Tokens Credited:\s*\+?(\d+(?:\.\d+)?)\s*Billion Tokens\s*\((\d+(?:\.\d+)?)B\)/i,
  );
  const cost = amount(text, /Charged from Main Balance:\s*Rp\s*([\d.,]+)/i),
    balance = amount(text, /Main Balance Remaining[^\n:]*:\s*IDR\s*([\d.,]+)/i);
  if (
    !code ||
    !q ||
    Number(q[1]) !== Number(q[2]) ||
    cost === null ||
    balance === null
  )
    return null;
  return { code, quantity: Number(q[1]), cost, balance, raw: text };
}
