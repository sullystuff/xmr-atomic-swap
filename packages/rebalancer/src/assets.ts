import type { AssetId, PriceSource } from './types.js';

export const ASSET_IDS: readonly AssetId[] = ['xmr', 'sol', 'eth', 'usdc_sol', 'usdc_eth'];
export const DECIMALS: Record<AssetId, number> = { xmr: 12, sol: 9, eth: 18, usdc_sol: 6, usdc_eth: 6 };
/** Which allow-list an address for this asset is checked against. */
export const ADDRESS_FAMILY: Record<AssetId, 'xmr' | 'sol' | 'eth'> = { xmr: 'xmr', sol: 'sol', usdc_sol: 'sol', eth: 'eth', usdc_eth: 'eth' };

/** Exact conversion of a decimal string or JSON number to atomic units. Digits beyond the asset's precision are cut (never rounded up). */
export function parseUnits(value: string | number, decimals: number): bigint {
  let s = typeof value === 'number' ? numberToPlain(value) : value.trim();
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) throw new Error(`not a non-negative decimal amount: ${JSON.stringify(value)}`);
  if (s.startsWith('.')) s = '0' + s;
  const [whole = '0', frac = ''] = s.split('.');
  return BigInt(whole + frac.slice(0, decimals).padEnd(decimals, '0'));
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`not a non-negative amount: ${n}`);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

export function formatUnits(amount: bigint, decimals: number): string {
  if (amount < 0n) throw new Error('negative amount');
  const s = amount.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export const toAtomic = (asset: AssetId, value: string | number): bigint => parseUnits(value, DECIMALS[asset]);
export const fromAtomic = (asset: AssetId, amount: bigint): string => formatUnits(amount, DECIMALS[asset]);

/** Whole units as a float. For USD valuation only; never for an amount that is sent. */
export function toFloat(asset: AssetId, amount: bigint): number {
  return Number(formatUnits(amount, DECIMALS[asset]));
}

export async function usdValue(prices: PriceSource, asset: AssetId, amount: bigint): Promise<number> {
  const p = await prices.usd(asset);
  if (!Number.isFinite(p) || p <= 0) throw new Error(`no reference price for ${asset}`);
  return toFloat(asset, amount) * p;
}

/** Atomic units of `asset` worth `usd` at the reference price, rounded down. */
export async function unitsForUsd(prices: PriceSource, asset: AssetId, usd: number): Promise<bigint> {
  const p = await prices.usd(asset);
  if (!Number.isFinite(p) || p <= 0) throw new Error(`no reference price for ${asset}`);
  return parseUnits((usd / p).toFixed(DECIMALS[asset] > 12 ? 12 : DECIMALS[asset]), DECIMALS[asset]);
}

/** Total cost against the reference price (DESIGN "Cost limits"). */
export async function costAgainstReference(
  prices: PriceSource, from: AssetId, amountIn: bigint, to: AssetId, amountOut: bigint, networkFeesUsd = 0,
): Promise<{ inUsd: number; outUsd: number; feesUsd: number; costPct: number }> {
  const inUsd = await usdValue(prices, from, amountIn);
  const outUsd = await usdValue(prices, to, amountOut);
  if (inUsd <= 0) throw new Error('zero input value');
  const feesUsd = inUsd - outUsd + networkFeesUsd;
  return { inUsd, outUsd, feesUsd, costPct: (feesUsd / inUsd) * 100 };
}

export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b + c - 1n) / c;
}
