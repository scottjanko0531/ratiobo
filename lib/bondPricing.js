/**
 * lib/bondPricing.js
 *
 * Synthetic bond pricing (docs/specs/bond-lens.md §3.4) -- exact semiannual
 * repricing, not a duration approximation. Lets Bond Lens build
 * constant-maturity return series from FRED yields for periods before the
 * relevant ETF existed, and cross-check against live ETF returns.
 * Pure math -- no DOM, no React, no Supabase, safe to import anywhere.
 */

/**
 * Price (per 100 face value) of a bond paying `couponRate` (annual, e.g.
 * 0.045) semiannually, discounted at `yieldRate` (annual, semiannual
 * compounding) over `years` to maturity. At couponRate === yieldRate this
 * returns exactly 100 (par), which is what "price_par_bond" in the spec
 * refers to -- a bond priced relative to its own par-issue coupon.
 */
export function priceParBond(couponRate, yieldRate, years) {
  const periods = Math.round(years * 2);
  if (periods <= 0) return 100;
  const coupon = (couponRate / 2) * 100;
  const rate = yieldRate / 2;
  let price = 0;
  for (let t = 1; t <= periods; t++) {
    price += coupon / Math.pow(1 + rate, t);
  }
  price += 100 / Math.pow(1 + rate, periods);
  return price;
}
