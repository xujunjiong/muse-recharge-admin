// Per-package payment caps in IDR. The worker refuses to pay when the bot
// quote exceeds the cap. 30B is intentionally generous (real price 40500 as
// of 2026-10-19) so bot price hikes don't block single recharges.
export const PACKAGE_PRICES: Readonly<Record<number, number>> = {
  1: 1700,
  5: 7500,
  10: 14000,
  15: 21000,
  20: 26000,
  30: 50000,
};
