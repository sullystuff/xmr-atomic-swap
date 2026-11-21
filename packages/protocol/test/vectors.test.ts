// The vector files against this package's constants and types, and the EIP-712 vectors against
// two independent implementations: viem (hashing and RFC 6979 signing) and foundry's cast.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashTypedData, recoverTypedDataAddress, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as p from '../src/index.js';
import { vector } from './helpers.js';

describe('deadlines.json mirrors the constants of this package', () => {
  const d = vector('deadlines');
  const names: [string, keyof p.ChainConsts][] = [
    ['FEE_BPS', 'feeBps'], ['MAX_DEPOSIT_BPS', 'maxDepositBps'], ['HOLD_SECS', 'holdSecs'], ['SPLIT_SECS', 'splitSecs'],
    ['EXPIRY_SECS', 'expirySecs'], ['BLOCK_ALLOWANCE_SECS', 'blockAllowanceSecs'], ['CUT_MARGIN_SECS', 'cutMarginSecs'],
    ['MARGIN_SECS', 'marginSecs'], ['FINALITY_SECS', 'finalitySecs'], ['MIN_NOTICE_SECS', 'minNoticeSecs'],
    ['MAX_NOTICE_SECS', 'maxNoticeSecs'], ['MIN_CLAIM_DELAY_SECS', 'minClaimDelaySecs'], ['MAX_APPROVAL_SECS', 'maxApprovalSecs'],
    ['MAX_FINAL_SECS', 'maxFinalSecs'], ['READY_MIN_SECS_PER_CONF', 'readyMinSecsPerConf'], ['CLOSE_GRACE_SECS', 'closeGraceSecs'],
    ['LINK_DELAY_SECS', 'linkDelaySecs'], ['MAX_OPEN_PENDING', 'maxOpenPending'], ['EXPLICIT_APPROVE', 'explicitApprove'],
    ['OPEN_SECRET_CALLS', 'openSecretCalls'], ['LAPSE_IS_FAULT', 'lapseIsFault'],
  ];
  for (const chain of ['solana', 'ethereum'] as const) {
    it(chain, () => {
      const fromVector = d.constants[chain];
      for (const [vectorName, key] of names) expect(p.CHAIN_CONSTS[chain][key], vectorName).toBe(fromVector[vectorName]);
      // Nothing in the vector is left unmirrored, and nothing here is unchecked.
      expect(Object.keys(fromVector).sort()).toEqual([...names.map(([n]) => n), 'MIN_APPROVAL_SECS'].sort());
      expect(Object.keys(p.CHAIN_CONSTS[chain]).sort()).toEqual(names.map(([, k]) => k).sort());
      expect(fromVector.MIN_APPROVAL_SECS).toBe(p.MIN_APPROVAL_SECS);
    });
  }
});

describe('transitions.json uses the names of this package', () => {
  const t = vector('transitions');
  it('counter, state and error names', () => {
    expect(t.counter_names).toEqual([...p.COUNTER_NAMES]);
    const states = new Set<string>();
    const errors: Record<string, Set<string>> = { solana: new Set(), ethereum: new Set() };
    for (const row of t.rows) {
      const e = row.step.expect;
      if (e.ok) {
        states.add(e.state);
        expect(p.SWAP_STATE[e.state as p.SwapStateName], e.state).toBe(e.swap.state_code);
        if (e.counter !== null) expect(p.COUNTER_NAMES[e.counter]).toBe(e.counter_name);
      } else errors[row.chain]!.add(e.error);
    }
    expect([...states].sort()).toEqual(p.SWAP_STATE_NAMES.filter((s) => s !== 'NONE').sort());
    // Every error a row expects exists in that chain's frozen error list.
    for (const name of errors.solana!) expect(p.ERROR_NAMES, name).toContain(name);
    for (const name of errors.ethereum!) expect(p.ETH_ERROR_NAMES, name).toContain(name);
    expect(errors.solana!.has('ScalarMismatch')).toBe(true);
    expect(errors.ethereum!.has('BadSecret')).toBe(true);
    expect(t.summary.solana.rows).toBeGreaterThan(300);
    expect(t.summary.ethereum.sequences).toBeGreaterThan(150);
  });
});

describe('error names in the signed-object vectors exist on their chain', () => {
  it('sol_signed.json and eip712.json', () => {
    for (const c of vector('sol_signed').cases.filter((c: any) => !c.valid)) {
      // `SignatureInvalid` is the Ed25519 precompile failing the transaction, not a program error.
      if (c.error !== 'SignatureInvalid') expect(p.ERROR_NAMES, c.name).toContain(c.error);
    }
    for (const c of vector('eip712').cases.filter((c: any) => !c.valid)) expect(p.ETH_ERROR_NAMES, c.name).toContain(c.error);
  });
});

describe('eip712.json against viem and cast', () => {
  const s = vector('eip712');
  const account = privateKeyToAccount(s.operator_private_key);
  /** viem wants bigint for 64-bit and larger integers; the JSON carries decimal strings. */
  function message(td: any): any {
    const m = { ...td.message };
    for (const f of td.types[td.primaryType]) {
      if (/^uint(64|256)$/.test(f.type)) m[f.name] = BigInt(m[f.name]);
      else if (/^uint(64|256)\[3\]$/.test(f.type)) m[f.name] = m[f.name].map(BigInt);
    }
    return m;
  }
  const args = (td: any) => ({ domain: { ...td.domain, chainId: BigInt(td.domain.chainId) }, types: p.EIP712_TYPES, primaryType: td.primaryType, message: message(td) }) as any;

  it('the fixed operator key and the type definitions', () => {
    expect(account.address.toLowerCase()).toBe(s.operator);
    expect(s.quote_type).toBe(p.EIP712_TYPE_STRINGS.Quote);
    expect(s.approval_type).toBe(p.EIP712_TYPE_STRINGS.Approval);
    expect(s.domain.name).toBe(p.EIP712_NAME);
    expect(s.domain.version).toBe(p.EIP712_VERSION);
    expect(s.any_token).toBe(p.ETH_ANY_TOKEN.toLowerCase());
    expect(s.any_direction).toBe(p.ETH_ANY_DIRECTION);
    for (const c of s.cases.filter((c: any) => c.input.typed_data)) {
      const td = c.input.typed_data;
      expect(td.types[td.primaryType], c.name).toEqual(p.EIP712_TYPES[td.primaryType as 'Quote' | 'Approval']);
    }
  });

  it('viem hashes every typed-data object to the vector digest (fixed-size arrays included)', () => {
    let n = 0;
    for (const c of s.cases) {
      const td = c.input.typed_data;
      const digest = c.output?.digest ?? c.input.digest;
      if (!td || !digest) continue;
      expect(hashTypedData(args(td)), c.name).toBe(digest);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(15);
  });

  it('viem signs to the same 65 bytes and verifies them', async () => {
    const signed = s.cases.filter((c: any) => c.valid && c.output.signature);
    expect(signed.length).toBeGreaterThanOrEqual(6);
    for (const c of signed) {
      const a = args(c.input.typed_data);
      expect(await account.signTypedData(a), c.name).toBe(c.output.signature);
      expect(await verifyTypedData({ ...a, address: s.operator, signature: c.output.signature }), c.name).toBe(true);
      expect((await recoverTypedDataAddress({ ...a, signature: c.output.signature })).toLowerCase()).toBe(c.output.signer);
    }
  });

  it('replayed, tampered and high-s signatures do not verify', async () => {
    const bad = s.cases.filter((c: any) => c.error === 'BadSigner');
    expect(bad.map((c: any) => c.name).sort()).toEqual(['quote-high-s-signature', 'quote-replayed-on-another-chain', 'quote-replayed-on-another-contract', 'quote-tampered-price']);
    for (const c of bad) {
      const a = args(c.input.typed_data);
      if (c.name === 'quote-high-s-signature') {
        // The curve equation holds for the high-s twin; the contract (OpenZeppelin ECDSA) refuses
        // it because s is above n/2.
        const sBig = BigInt('0x' + c.input.signature.slice(66, 130));
        expect(sBig > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n, c.name).toBe(true);
      } else {
        expect(await verifyTypedData({ ...a, address: c.input.expected_signer, signature: c.input.signature }), c.name).toBe(false);
      }
    }
  });

  it("foundry's cast signs the typed-data JSON to the same bytes", () => {
    // Offline; the key is the fixed test key of the vector file.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'xmrswap-eip712-'));
    for (const name of ['quote-public-eth-a', 'quote-bound-usdc-a', 'quote-extremes', 'approval-any']) {
      const c = s.cases.find((x: any) => x.name === name);
      const file = path.join(dir, `${name}.json`);
      writeFileSync(file, JSON.stringify(c.input.typed_data));
      const out = execFileSync('cast', ['wallet', 'sign', '--data', '--from-file', file, '--private-key', s.operator_private_key], { encoding: 'utf8' }).trim();
      expect(out, name).toBe(c.output.signature);
    }
  });

  it('validity is inclusive on both ends', () => {
    const by = (name: string) => s.cases.find((c: any) => c.name === name);
    expect(by('quote-at-valid-until').valid).toBe(true);
    expect(by('quote-at-valid-until-plus-1').error).toBe('Expired');
    expect(by('approval-at-not-before-minus-1').error).toBe('Expired');
    expect(by('approval-at-not-before').valid).toBe(true);
    expect(by('approval-at-valid-until').valid).toBe(true);
    expect(by('approval-at-valid-until-plus-1').error).toBe('Expired');
  });
});

describe('envelope.json: the largest responses are well-formed messages', () => {
  it('parse as the message types of this package', () => {
    const s = vector('envelope');
    const largest = s.cases.filter((c: any) => c.name.startsWith('largest-'));
    expect(largest.length).toBe(4);
    for (const c of largest) {
      const m = p.parseMessage(c.input.plaintext_utf8);
      expect(p.MAKER_MESSAGE_TYPES, c.name).toContain(m.t);
      expect(c.output.length).toBeLessThanOrEqual(p.ENVELOPE_MAX_ONCHAIN);
    }
    // The Ethereum quote response carries the 316-byte compact quote.
    const q = p.parseMessage(largest.find((c: any) => c.name === 'largest-quote-response-ethereum').input.plaintext_utf8) as p.QuoteResponseEthereum;
    expect(Uint8Array.from(atob(q.quote), (ch) => ch.charCodeAt(0)).length).toBe(p.COMPACT_QUOTE_SIGNED_LEN);
    for (const c of s.cases.filter((c: any) => c.valid && !c.name.startsWith('largest-'))) expect(() => p.parseMessage(c.input.plaintext_utf8), c.name).not.toThrow();
    expect(s.max_onchain).toBe(p.ENVELOPE_MAX_ONCHAIN);
    expect(s.max_tor).toBe(p.ENVELOPE_MAX_TOR);
  });
});

describe('other suites', () => {
  it('joint_address prefixes, DLEQ sizes, sol_signed constants', () => {
    expect(vector('joint_address').prefixes).toEqual(p.MONERO_ADDRESS_PREFIX);
    const dleq = vector('dleq');
    expect(dleq.max_blob).toBe(p.DLEQ_MAX_BLOB);
    for (const c of dleq.cases.filter((c: any) => c.valid)) expect(c.input.length).toBe(p.DLEQ_BLOB_LEN);
    const sol = vector('sol_signed');
    expect(sol.message_len).toBe(p.SOL_APPROVAL_LEN);
    expect(sol.any).toBe(p.SOL_APPROVAL_ANY);
    expect(vector('eip712').compact_len).toBe(p.COMPACT_QUOTE_LEN);
  });
});
