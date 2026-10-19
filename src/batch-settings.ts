import { PACKAGE_PRICES } from "./pricing.js";
import { QUANTITIES, positiveInt, type Candidate } from "./types.js";

// Shared by the preview and API so both resolve the same quantity and payment cap.
export function resolveBatchRow(
  row: Pick<Candidate, "row" | "quantity" | "maxCost">,
  quantityOverride: number | null | undefined,
  costOverride: number | null | undefined,
) {
  const quantity = quantityOverride ?? row.quantity;
  const errors: string[] = [];
  if (!QUANTITIES.includes(quantity as any))
    errors.push(`第 ${row.row} 行缺少有效充值量，请补充表格或选择统一充值量`);
  const maxCost =
    costOverride ??
    row.maxCost ??
    (quantity == null ? null : PACKAGE_PRICES[quantity]);
  if (!positiveInt(maxCost)) errors.push(`第 ${row.row} 行费用上限无效`);
  return { quantity, maxCost: maxCost ?? null, errors };
}
