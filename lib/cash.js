// Sign convention for how a transaction moves a cash holding's balance.
// Positive = cash increases (inflow), negative = cash decreases (outflow).
const CASH_DIRECTION = {
  buy: -1,
  sell: 1,
  dividend: 1,
  interest: 1,
  principal: 1,
  transfer_in: 1,
  transfer_out: -1,
  fee: -1,
  beg_bal: 1
};

// Transaction types tied to a specific (non-cash) holding that also move
// money into/out of that holding's account-level cash holding.
export const CASH_LEG_TYPES = new Set(["buy", "sell", "dividend", "interest", "principal"]);

// Net dollar amount a transaction moves into (+) or out of (-) a cash holding.
export function cashAmount(txnType, amount, fees) {
  const dir = CASH_DIRECTION[txnType];
  if (!dir) return 0;
  const amt = Number(amount ?? 0);
  const f = Number(fees ?? 0);
  return dir > 0 ? dir * (amt - f) : dir * (amt + f);
}
