// The frozen interface artifacts and the two conformance checkers: the checkers accept the
// frozen files and report every kind of drift they claim to catch.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, hashTypedData, keccak256, toEventSelector, toFunctionSelector, toHex } from 'viem';
import * as p from '../src/index.js';
import { frozenAbi, frozenIdl, repoRoot } from './helpers.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'xmrswap-ifc-'));
const checker = (name: string) => path.join(repoRoot, 'interfaces/tools', name);
function run(tool: string, value: unknown): { status: number; out: string } {
  const file = path.join(tmp, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(value));
  const r = spawnSync(process.execPath, [checker(tool), file], { encoding: 'utf8' });
  return { status: r.status ?? -1, out: r.stdout + r.stderr };
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('check-idl.mjs', () => {
  const idl = frozenIdl();

  it('accepts the frozen IDL, and ignores docs, PDA seeds, addresses, metadata and key order', () => {
    expect(run('check-idl.mjs', idl)).toMatchObject({ status: 0 });
    const cosmetic = clone(idl);
    cosmetic.metadata = { name: 'other', version: '9.9.9', spec: '0.1.0', description: 'x' };
    for (const i of cosmetic.instructions) {
      i.docs = ['changed'];
      for (const a of i.accounts) {
        delete a.pda;
        delete a.address;
        delete a.relations;
        a.docs = ['changed'];
      }
    }
    for (const t of cosmetic.types) {
      delete t.docs;
      for (const f of t.type.fields ?? []) f.docs = ['changed'];
    }
    cosmetic.instructions.reverse();
    cosmetic.types.reverse();
    cosmetic.accounts.reverse();
    // Key order inside objects.
    cosmetic.instructions = cosmetic.instructions.map((i: any) => Object.fromEntries(Object.entries(i).reverse()));
    const r = run('check-idl.mjs', cosmetic);
    expect(r.out).toContain('check-idl: OK');
    expect(r.status).toBe(0);
  });

  const mutations: [string, (idl: any) => void, RegExp][] = [
    ['an instruction removed', (d) => d.instructions.pop(), /missing/],
    ['an instruction added', (d) => d.instructions.push({ ...clone(d.instructions[0]), name: 'extra_ix', discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }), /not in the frozen interface/],
    ['an argument renamed', (d) => (d.instructions.find((i: any) => i.name === 'claim').args[0].name = 'scalar'), /instructions\.claim\.args/],
    ['an argument type changed', (d) => (d.instructions.find((i: any) => i.name === 'reject').args[1].type = 'u16'), /instructions\.reject\.args/],
    ['an argument added', (d) => d.instructions.find((i: any) => i.name === 'set_ready').args.push({ name: 'x', type: 'u8' }), /instructions\.set_ready\.args/],
    ['accounts reordered', (d) => d.instructions.find((i: any) => i.name === 'lock').accounts.reverse(), /instructions\.lock\.accounts/],
    ['a signer flag dropped', (d) => delete d.instructions.find((i: any) => i.name === 'approve').accounts[0].signer, /signer/],
    ['a writable flag added', (d) => (d.instructions.find((i: any) => i.name === 'approve').accounts[3].writable = true), /writable/],
    ['an optional flag dropped', (d) => delete d.instructions.find((i: any) => i.name === 'lock').accounts[6].optional, /optional/],
    ['an account renamed in a list', (d) => (d.instructions.find((i: any) => i.name === 'claim').accounts[5].name = 'payout'), /instructions\.claim\.accounts/],
    ['a Swap field retyped', (d) => (d.types.find((t: any) => t.name === 'Swap').type.fields[2].type = 'u16'), /types\.Swap/],
    ['Swap fields reordered', (d) => d.types.find((t: any) => t.name === 'Swap').type.fields.reverse(), /types\.Swap/],
    ['an event field added', (d) => d.types.find((t: any) => t.name === 'Claimed').type.fields.push({ name: 'x', type: 'u8' }), /types\.Claimed/],
    ['an event removed', (d) => (d.events = d.events.filter((e: any) => e.name !== 'PayoutParked')), /events\.PayoutParked/],
    ['an account type renamed', (d) => (d.accounts.find((a: any) => a.name === 'Maker').name = 'MakerV2'), /accounts\.Maker/],
    ['errors reordered', (d) => ([d.errors[1].name, d.errors[2].name] = [d.errors[2].name, d.errors[1].name]), /errors\[1:Paused\]/],
    ['an error appended', (d) => d.errors.push({ code: 6055, name: 'Extra' }), /errors: length 56/],
    ['a discriminator changed', (d) => (d.instructions[0].discriminator[0] ^= 1), /discriminator/],
    ['another program id', (d) => (d.address = '11111111111111111111111111111111'), /program-id\.txt/],
  ];
  for (const [what, mutate, expected] of mutations) {
    it(`rejects ${what}`, () => {
      const changed = clone(idl);
      mutate(changed);
      const r = run('check-idl.mjs', changed);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(expected);
    });
  }

  it('the frozen program id file matches the IDL', () => {
    expect(readFileSync(path.join(repoRoot, 'interfaces/solana/program-id.txt'), 'utf8').trim()).toBe(idl.address);
  });
});

describe('check-abi.mjs', () => {
  const abi = frozenAbi();
  const ozBase = [
    { type: 'constructor', inputs: [], stateMutability: 'nonpayable' },
    { type: 'function', name: 'initialize', inputs: [{ name: 'owner_', type: 'address' }, { name: 'treasury_', type: 'address' }, { name: 'usdc_', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
    { type: 'function', name: 'owner', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
    { type: 'function', name: 'upgradeToAndCall', inputs: [{ name: 'newImplementation', type: 'address' }, { name: 'data', type: 'bytes' }], outputs: [], stateMutability: 'payable' },
    { type: 'event', name: 'Upgraded', inputs: [{ name: 'implementation', type: 'address', indexed: true }], anonymous: false },
    { type: 'error', name: 'OwnableUnauthorizedAccount', inputs: [{ name: 'account', type: 'address' }] },
  ];

  it('accepts the frozen ABI, a forge artifact, and a contract that adds its OpenZeppelin bases', () => {
    expect(run('check-abi.mjs', abi).status).toBe(0);
    expect(run('check-abi.mjs', { abi, bytecode: { object: '0x' } }).status).toBe(0);
    const r = run('check-abi.mjs', [...abi, ...ozBase]);
    expect(r.out).toContain('check-abi: OK');
    expect(r.out).toContain('extra error (allowed): error OwnableUnauthorizedAccount(address)');
    expect(r.status).toBe(0);
    // internalType and entry order are not part of the interface.
    const cosmetic = clone(abi).reverse();
    for (const e of cosmetic) for (const i of e.inputs ?? []) i.internalType = 'whatever';
    expect(run('check-abi.mjs', cosmetic).status).toBe(0);
  });

  const find = (d: any[], type: string, name: string) => d.find((e) => e.type === type && e.name === name);
  const mutations: [string, (abi: any[]) => void, RegExp][] = [
    ['a function removed', (d) => d.splice(d.indexOf(find(d, 'function', 'claim')), 1), /missing: function claim\(bytes32,uint256\)/],
    ['a parameter type changed', (d) => (find(d, 'function', 'claim').inputs[1].type = 'bytes32'), /missing: function claim\(bytes32,uint256\) \(found function claim\(bytes32,bytes32\)\)/],
    ['a parameter renamed', (d) => (find(d, 'function', 'refund').inputs[1].name = 'scalar'), /differs: function refund/],
    ['mutability changed', (d) => (find(d, 'function', 'fund').stateMutability = 'nonpayable'), /differs: function fund/],
    ['a return type changed', (d) => (find(d, 'function', 'isKeyUsed').outputs[0].type = 'uint8'), /differs: function isKeyUsed/],
    ['a struct field renamed', (d) => (find(d, 'function', 'hashQuote').inputs[0].components[0].name = 'makerAddr'), /differs: function hashQuote/],
    ['a struct field retyped', (d) => (find(d, 'function', 'hashApproval').inputs[0].components[4].type = 'uint256'), /missing: function hashApproval/],
    ['an event parameter no longer indexed', (d) => (find(d, 'event', 'Claimed').inputs[0].indexed = false), /differs: event Claimed/],
    ['an event removed', (d) => d.splice(d.indexOf(find(d, 'event', 'PayoutDeferred')), 1), /missing: event PayoutDeferred/],
    ['an error removed', (d) => d.splice(d.indexOf(find(d, 'error', 'BadSecret')), 1), /missing: error BadSecret\(\)/],
    ['an error given a parameter', (d) => find(d, 'error', 'TooLate').inputs.push({ name: 'at', type: 'uint64' }), /missing: error TooLate\(\)/],
    ['an unlisted external function', (d) => d.push({ type: 'function', name: 'sweep', inputs: [], outputs: [], stateMutability: 'nonpayable' }), /not in the frozen interface: function sweep\(\)/],
    ['an unlisted event', (d) => d.push({ type: 'event', name: 'Swept', inputs: [], anonymous: false }), /not in the frozen interface: event Swept\(\)/],
  ];
  for (const [what, mutate, expected] of mutations) {
    it(`rejects ${what}`, () => {
      const changed = clone(abi);
      mutate(changed);
      const r = run('check-abi.mjs', changed);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(expected);
    });
  }
});

describe('the frozen ABI', () => {
  const abi = frozenAbi();
  const names = (type: string) => abi.filter((e) => e.type === type).map((e) => e.name);

  it('is what the package exports', () => {
    expect(p.IXmrSwapAbi).toEqual(abi);
  });

  it('has exactly the errors of SPEC 5.5, without parameters', () => {
    expect(names('error').sort()).toEqual([...p.ETH_ERROR_NAMES].sort());
    expect(abi.filter((e) => e.type === 'error').every((e) => e.inputs.length === 0)).toBe(true);
    // 37 of SPEC 5.5 and the four of Amendment 1, appended.
    expect(p.ETH_ERROR_NAMES.length).toBe(41);
    expect(p.ETH_ERROR_NAMES.slice(37)).toEqual(['SwapCapExceeded', 'OpenCapExceeded', 'WatcherNotAllowed', 'FreezeWindowOutOfRange']);
  });

  it('has every function of SPEC 5.3', () => {
    const required = [
      'registerMaker', 'setOperator', 'setPayout', 'setSolanaLink', 'setPaused', 'bumpEpochs', 'cancelQuote', 'revokeApproval',
      'lock', 'take', 'approve', 'fund', 'reject', 'cancelPending', 'expirePending', 'postNotice', 'setReady', 'abort',
      'refundUnnoticed', 'expireUnnoticed', 'refund', 'claim', 'releaseDeposit', 'withhold', 'splitDeposit', 'publishEvidence',
      'withdrawOwed', 'withdrawTreasury', 'postMessage', 'getSwap', 'getMaker', 'counters', 'swapsOf', 'hashQuote', 'hashApproval',
      'domainSeparator', 'isKeyUsed', 'version',
      // Amendment 1 (SPEC 11.8).
      'freeze', 'setCaps', 'setCapsOn', 'capsOf', 'pushOwed',
    ];
    for (const f of required) expect(names('function'), f).toContain(f);
    const fn = (name: string) => abi.find((e) => e.type === 'function' && e.name === name);
    expect(fn('lock').stateMutability).toBe('payable');
    expect(fn('take').stateMutability).toBe('payable');
    expect(fn('fund').stateMutability).toBe('payable');
    expect(fn('claim').inputs.map((i: any) => i.type)).toEqual(['bytes32', 'uint256']);
    expect(fn('refund').inputs.map((i: any) => i.type)).toEqual(['bytes32', 'uint256']);
    expect(fn('counters').outputs[0].type).toBe('uint32[40]');
    // Amendment 1: `watcher` appended to lock and fund, `payout` to take.
    expect(fn('lock').inputs.map((i: any) => i.name)).toEqual(['q', 'sig', 'xmr', 'maxPay', 'swapNonce', 'sessionKey', 'sessionBudget', 'tk', 'leaf', 'a', 'approvalSig', 'watcher']);
    expect(fn('take').inputs.map((i: any) => i.name)).toEqual(['q', 'sig', 'xmr', 'minReceive', 'swapNonce', 'sessionKey', 'sessionBudget', 'tk', 'a', 'approvalSig', 'payout']);
    expect(fn('fund').inputs.map((i: any) => [i.name, i.type])).toEqual([['swapId', 'bytes32'], ['expectedOpen', 'bytes32'], ['key', 'address'], ['key2', 'address'], ['spendPub', 'bytes32'], ['viewShare', 'bytes32'], ['watcher', 'address']]);
    expect(fn('freeze').inputs.map((i: any) => i.type)).toEqual(['bytes32']);
    expect(fn('setCaps').inputs.map((i: any) => [i.name, i.type])).toEqual([['token', 'address'], ['maxSwap', 'uint128'], ['maxOpen', 'uint128']]);
    expect(fn('setCapsOn').inputs.map((i: any) => i.type)).toEqual(['bool']);
    expect(fn('capsOf').stateMutability).toBe('view');
    expect(fn('capsOf').outputs.map((i: any) => [i.name, i.type])).toEqual([['on', 'bool'], ['maxSwap', 'uint128'], ['maxOpen', 'uint128'], ['openValue', 'uint128']]);
    expect(fn('pushOwed').inputs.map((i: any) => [i.name, i.type])).toEqual([['token', 'address'], ['account', 'address']]);
    // 45 functions before the amendment, five added.
    expect(names('function').length).toBe(50);
  });

  it('every swap event indexes swapId and maker and carries the counter', () => {
    expect(names('event').sort()).toEqual(
      [...p.ETH_SWAP_EVENT_NAMES, 'PayoutDeferred', 'MakerRegistered', 'OperatorChanged', 'PayoutChanged', 'LinkChanged', 'PausedChanged', 'EpochsBumped', 'QuoteCancelled', 'ApprovalRevoked', 'Message', 'CapsChanged', 'CapsSwitched'].sort(),
    );
    for (const name of p.ETH_SWAP_EVENT_NAMES) {
      const e = abi.find((x) => x.type === 'event' && x.name === name);
      expect(e.inputs[0], name).toMatchObject({ name: 'swapId', type: 'bytes32', indexed: true });
      expect(e.inputs[1], name).toMatchObject({ name: 'maker', type: 'address', indexed: true });
      expect(e.inputs.find((i: any) => i.name === 'counter'), name).toMatchObject({ type: 'uint8', indexed: false });
    }
    const message = abi.find((x) => x.type === 'event' && x.name === 'Message');
    expect(message.inputs.map((i: any) => [i.name, i.indexed])).toEqual([['from', true], ['to', true], ['swapId', true], ['payload', false]]);
    // Selectors are computable from the frozen file (smoke test of the ABI with viem).
    expect(toFunctionSelector(abi.find((e) => e.name === 'claim'))).toBe(toFunctionSelector('claim(bytes32,uint256)'));
    expect(toEventSelector(abi.find((e) => e.name === 'Approved'))).toBe(toEventSelector('Approved(bytes32,address,uint8)'));
    // Amendment 1: Frozen, and the fields Locked and Funded gained at their ends.
    const ev = (name: string) => abi.find((x) => x.type === 'event' && x.name === name).inputs.map((i: any) => [i.name, i.type, !!i.indexed]);
    expect(ev('Frozen')).toEqual([['swapId', 'bytes32', true], ['maker', 'address', true], ['counter', 'uint8', false], ['taker', 'address', false], ['watcher', 'address', false], ['frozenUntil', 'uint64', false]]);
    expect(ev('Locked').slice(-2)).toEqual([['payout', 'address', false], ['watcher', 'address', false]]);
    expect(ev('Funded').at(-1)).toEqual(['watcher', 'address', false]);
    expect(ev('CapsChanged')).toEqual([['token', 'address', true], ['maxSwap', 'uint128', false], ['maxOpen', 'uint128', false]]);
    expect(ev('CapsSwitched')).toEqual([['on', 'bool', false]]);
  });

  it('the Quote and Approval structs match the EIP-712 type definitions', () => {
    const struct = (fn: string) => abi.find((e) => e.type === 'function' && e.name === fn).inputs[0].components.map((c: any) => ({ name: c.name, type: c.type }));
    expect(struct('hashQuote')).toEqual(p.EIP712_TYPES.Quote);
    expect(struct('hashApproval')).toEqual(p.EIP712_TYPES.Approval);
    const typeString = (name: 'Quote' | 'Approval') => `${name}(${p.EIP712_TYPES[name].map((f) => `${f.type} ${f.name}`).join(',')})`;
    expect(typeString('Quote')).toBe(p.EIP712_TYPE_STRINGS.Quote);
    expect(typeString('Approval')).toBe(p.EIP712_TYPE_STRINGS.Approval);
    // The storage records returned by the views have the fields of SPEC 5.2.
    const swap = abi.find((e) => e.name === 'getSwap').outputs[0].components.map((c: any) => c.name);
    expect(swap.slice(0, 5)).toEqual(['taker', 'maker', 'token', 'sessionKey', 'swapNonce']);
    expect(swap).toContain('noticeCiphertext');
    expect(swap).toContain('revealed');
    // Amendment 1 appended four fields; the twelve times of SPEC 5.2 are still where they were.
    expect(swap.slice(-16, -4)).toEqual(['tLock', 'tPendingDeadline', 'tActive', 'tNoteDeadline', 'tNotice', 'tCut', 'tClaimOpen', 'tReady', 'tClaimDeadline', 'tFinal', 'tRefund', 'tSettled']);
    const swapTail = abi.find((e) => e.name === 'getSwap').outputs[0].components.slice(-4).map((c: any) => [c.name, c.type]);
    expect(swapTail).toEqual([['payout', 'address'], ['watcher', 'address'], ['freezeSecs', 'uint32'], ['tFreeze', 'uint64']]);
    expect(p.EIP712_TYPES.Quote.at(-1)).toEqual({ name: 'freezeWindow', type: 'uint32' });
    expect(`WalletKey(${p.EIP712_TYPES.WalletKey.map((f) => `${f.type} ${f.name}`).join(',')})`).toBe(p.EIP712_TYPE_STRINGS.WalletKey);
    const maker = abi.find((e) => e.name === 'getMaker').outputs[0].components;
    expect(maker.map((c: any) => c.name)).toEqual(['operator', 'payout', 'quoteEpoch', 'approvalEpoch', 'paused', 'registeredAt', 'solanaOwner', 'solanaOwnerNext', 'solanaOwnerNextAt', 'openPending', 'responseSecsSum', 'counters']);
    expect(maker.at(-1).type).toBe('uint32[40]');
  });

  it('IXmrSwap.abi.json is what forge builds from IXmrSwap.sol', () => {
    // Offline; needs forge and solc 0.8.31 as every Ethereum package does.
    const out = execFileSync(path.join(repoRoot, 'interfaces/tools/build-abi.sh'), ['--check'], { encoding: 'utf8' });
    expect(out).toContain('matches');
  });

  it('eip712Domain helper and a typed-data hash through viem with the exported types', () => {
    const domain = p.eip712Domain(31337, '0xcccccccccccccccccccccccccccccccccccccccc');
    expect(domain).toEqual({ name: 'XmrAtomicSwap', version: '1', chainId: 31337n, verifyingContract: '0xcccccccccccccccccccccccccccccccccccccccc' });
    const message: p.EthApprovalMessage = { maker: p.ETH_NATIVE, taker: p.ETH_NATIVE, token: p.ETH_ANY_TOKEN, direction: p.ETH_ANY_DIRECTION, maxXmr: 1n, notBefore: 2n, validUntil: 3n, epoch: 4, approvalId: toHex(5, { size: 32 }) };
    const digest = hashTypedData({ domain, types: p.EIP712_TYPES, primaryType: 'Approval', message });
    // Recomputed from the definition: keccak256(0x1901 ‖ domainSeparator ‖ structHash).
    const domainSeparator = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(toHex('XmrAtomicSwap')), keccak256(toHex('1')), 31337n, domain.verifyingContract]));
    const structHash = keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint32' }, { type: 'bytes32' }],
      [keccak256(toHex(p.EIP712_TYPE_STRINGS.Approval)), message.maker, message.taker, message.token, message.direction, message.maxXmr, message.notBefore, message.validUntil, message.epoch, message.approvalId],
    ));
    expect(digest).toBe(keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}`));
  });
});
