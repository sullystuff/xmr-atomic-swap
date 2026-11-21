#!/usr/bin/env node
// Conformance check for the Ethereum contract: compares a contract ABI (for example the output
// of `forge inspect XmrSwap abi --json`) with the frozen interfaces/ethereum/IXmrSwap.abi.json
// (SPEC 10.3).
//
//   node interfaces/tools/check-abi.mjs ethereum/out/XmrSwap.abi.json
//
// Every function, event and error of the frozen interface must be present with identical
// parameter names, types (struct components included), indexed flags, outputs and state
// mutability. The contract may additionally expose what its OpenZeppelin bases of SPEC 5.1
// bring (the list below) and any further custom errors; any other extra function or event is
// an interface change and fails.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frozenPath = path.resolve(here, '../ethereum/IXmrSwap.abi.json');

/** Members inherited from Initializable, UUPSUpgradeable, Ownable2StepUpgradeable, EIP712Upgradeable, plus `initialize`. */
const INHERITED = new Set([
  'function initialize(address,address,address)',
  'function owner()',
  'function pendingOwner()',
  'function transferOwnership(address)',
  'function acceptOwnership()',
  'function renounceOwnership()',
  'function upgradeToAndCall(address,bytes)',
  'function proxiableUUID()',
  'function UPGRADE_INTERFACE_VERSION()',
  'function eip712Domain()',
  'event Initialized(uint64)',
  'event OwnershipTransferStarted(address,address)',
  'event OwnershipTransferred(address,address)',
  'event Upgraded(address)',
  'event EIP712DomainChanged()',
]);

/** Canonical type string, expanding tuples. */
function typeOf(p) {
  if (!p.type.startsWith('tuple')) return p.type;
  return `(${(p.components ?? []).map(typeOf).join(',')})${p.type.slice('tuple'.length)}`;
}
/** Parameter shape: names, types and nested component names; `internalType` is ignored. */
function param(p, withIndexed) {
  const out = { name: p.name ?? '', type: typeOf(p) };
  if (p.components) out.components = p.components.map((c) => param(c, false));
  if (withIndexed) out.indexed = !!p.indexed;
  return out;
}
export function signature(e) {
  return `${e.type} ${e.name}(${(e.inputs ?? []).map(typeOf).join(',')})`;
}
export function normalize(abi) {
  const out = {};
  for (const e of abi) {
    if (!['function', 'event', 'error'].includes(e.type)) continue;
    const entry = { inputs: (e.inputs ?? []).map((p) => param(p, e.type === 'event')) };
    if (e.type === 'function') {
      entry.outputs = (e.outputs ?? []).map((p) => param(p, false));
      entry.stateMutability = e.stateMutability;
    }
    if (e.type === 'event') entry.anonymous = !!e.anonymous;
    out[signature(e)] = entry;
  }
  return out;
}

export function compare(frozenAbi, actualAbi) {
  const frozen = normalize(frozenAbi);
  const actual = normalize(actualAbi);
  const problems = [];
  const notes = [];
  for (const [sig, f] of Object.entries(frozen)) {
    const a = actual[sig];
    if (!a) {
      // Same name with other parameters is the most useful hint.
      const name = sig.slice(0, sig.indexOf('('));
      const near = Object.keys(actual).filter((s) => s.startsWith(name + '('));
      problems.push(`missing: ${sig}${near.length ? ` (found ${near.join(', ')})` : ''}`);
    } else if (JSON.stringify(f) !== JSON.stringify(a)) {
      problems.push(`differs: ${sig}\n      frozen ${JSON.stringify(f)}\n      actual ${JSON.stringify(a)}`);
    }
  }
  for (const sig of Object.keys(actual)) {
    if (sig in frozen || INHERITED.has(sig)) continue;
    if (sig.startsWith('error ')) notes.push(`extra error (allowed): ${sig}`);
    else problems.push(`not in the frozen interface: ${sig}`);
  }
  return { problems, notes, counts: count(frozen) };
}
function count(n) {
  const c = { function: 0, event: 0, error: 0 };
  for (const sig of Object.keys(n)) c[sig.slice(0, sig.indexOf(' '))]++;
  return c;
}

function main() {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node interfaces/tools/check-abi.mjs <path to a contract ABI json>');
    process.exit(2);
  }
  const frozen = JSON.parse(readFileSync(frozenPath, 'utf8'));
  let actual = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(actual)) actual = actual.abi; // a forge artifact
  if (!Array.isArray(actual)) {
    console.error(`check-abi: ${file} is neither an ABI array nor a forge artifact`);
    process.exit(2);
  }
  const { problems, notes, counts } = compare(frozen, actual);
  for (const n of notes) console.log('  ' + n);
  if (problems.length) {
    console.error(`check-abi: ${file} differs from the frozen interface (${problems.length} difference${problems.length === 1 ? '' : 's'}):`);
    for (const p of problems) console.error('  ' + p);
    console.error('An interface change is a request against work package 1; do not edit interfaces/.');
    process.exit(1);
  }
  console.log(`check-abi: OK (${counts.function} functions, ${counts.event} events, ${counts.error} errors)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
