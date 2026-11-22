// Ethereum integration (M2): the SDK's client and flows against the real contract on anvil.
// Needs WP3's forge build output and `anvil` on the PATH; see harness.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { type Anvil, requireArtifact, startAnvil } from './harness.js';

let anvil: Anvil;

beforeAll(async () => {
  await init();
  requireArtifact('contract', '`cd ethereum && forge build`, WP3');
  requireArtifact('proxy', '`cd ethereum && forge build`, WP3');
  anvil = await startAnvil();
});
afterAll(async () => {
  await anvil?.stop();
});

describe('anvil endpoint', () => {
  it('is chain 31337 on loopback', async () => {
    expect(BigInt((await anvil.transport.request({ method: 'eth_chainId' })) as string)).toBe(31337n);
  });
});

describe('flows against the contract', () => {
  it.todo('deploy the implementation behind an ERC1967 proxy with a mock USDC; domainSeparator equals the SDK\'s EIP-712 domain');
  it.todo('hashQuote and hashApproval equal ethQuoteDigest and ethApprovalDigest for every eip712.json quote');
  it.todo('H-A eth and usdc_eth: pool leaf with a verified DLEQ proof, lock, approve, notice, ready, claim');
  it.todo('H-B eth and usdc_eth: take, fund, verifyFundedShare, notice, ready, claim');
  it.todo('E-1: lock refused without a verified maker proof; reject reason 1 without a taker proof; two takers name one leaf');
  it.todo('every refund path of takerStep and makerStep, driven by evm_increaseTime to each deadline');
  it.todo('isFinal: a claim is not acted on before the finalized tag passes its block');
  it.todo('custom errors decode by name from eth_call and eth_estimateGas reverts');
  it.todo('EthEventWatcher from a cursor; swapsOf + getSwap resume without logs');
  it.todo('P-1 payout parked for a blacklisted recipient, then withdrawOwed');
});
