// Reference package prices in IDR. The worker checks the bot quote against this cap before paying.
export const PACKAGE_PRICES: Readonly<Record<number, number>> = {
  1: 1700,
  5: 7500,
  10: 14000,
  15: 21000,
  20: 27000,
  30: 39000,
};
