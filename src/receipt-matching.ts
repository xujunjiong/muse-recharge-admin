import type { InputOrder, Quote, Receipt } from "./types.js";
export function receiptMatches(
  order: InputOrder,
  quote: Quote,
  receipt: Receipt,
) {
  return (
    receipt.code === order.code &&
    receipt.code === quote.code &&
    Number.isFinite(receipt.quantity) &&
    receipt.quantity > 0 &&
    receipt.quantity <= order.quantity &&
    Number.isSafeInteger(receipt.cost) &&
    receipt.cost >= 0 &&
    receipt.cost <= order.maxCost &&
    receipt.cost <= quote.cost &&
    (receipt.quantity !== order.quantity || receipt.cost === quote.cost) &&
    Number.isSafeInteger(receipt.balance) &&
    receipt.balance >= 0
  );
}
