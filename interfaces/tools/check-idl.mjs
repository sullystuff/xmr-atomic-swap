#!/usr/bin/env node
// Conformance check for the Solana program: compares an IDL produced by `anchor idl build` with
// the frozen interfaces/solana/xmr_swap.idl.json (SPEC 10.3).
//
//   node interfaces/tools/check-idl.mjs solana/program/target/idl/xmr_swap.json
//
// Compared: instruction names and discriminators; argument names and types; account order with
// signer, writable and optional flags; account, event and type layouts; error codes and order.
// Ignored: doc strings, PDA seed metadata, fixed addresses, account relations, the `address` and
// `metadata` blocks, and key order.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frozenPath = path.resolve(here, '../solana/xmr_swap.idl.json');
const programIdPath = path.resolve(here, '../solana/program-id.txt');

/** Remove docs everywhere and sort object keys, so only the interface is left. */
function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (k !== 'docs') out[k] = clean(v[k]);
    return out;
  }
  return v;
}
const byName = (list) => Object.fromEntries((list ?? []).map((x) => [x.name, x]));

/** Account lists may nest (composite accounts); flatten them with dotted names. */
function flattenAccounts(accounts, prefix = '') {
  return (accounts ?? []).flatMap((a) =>
    a.accounts
      ? flattenAccounts(a.accounts, `${prefix}${a.name}.`)
      : [{ name: prefix + a.name, writable: !!a.writable, signer: !!a.signer, optional: !!a.optional }],
  );
}

export function normalize(idl) {
  return {
    instructions: byName(
      (idl.instructions ?? []).map((i) => ({
        name: i.name,
        discriminator: i.discriminator,
        accounts: flattenAccounts(i.accounts),
        args: (i.args ?? []).map((a) => ({ name: a.name, type: clean(a.type) })),
        returns: i.returns === undefined ? null : clean(i.returns),
      })),
    ),
    accounts: byName((idl.accounts ?? []).map((a) => ({ name: a.name, discriminator: a.discriminator }))),
    events: byName((idl.events ?? []).map((e) => ({ name: e.name, discriminator: e.discriminator }))),
    // Order matters: the code is 6000 + index.
    errors: (idl.errors ?? []).map((e) => ({ code: e.code, name: e.name })),
    types: byName((idl.types ?? []).map((t) => clean({ ...t, docs: undefined }))),
  };
}

/** Structural diff as a list of human-readable lines. */
export function diff(frozen, actual, at = '') {
  if (JSON.stringify(frozen) === JSON.stringify(actual)) return [];
  const isObj = (v) => v && typeof v === 'object';
  if (Array.isArray(frozen) && Array.isArray(actual)) {
    const out = [];
    if (frozen.length !== actual.length) out.push(`${at}: length ${actual.length}, frozen ${frozen.length}`);
    for (let i = 0; i < Math.min(frozen.length, actual.length); i++) {
      const label = isObj(frozen[i]) && frozen[i].name ? `${at}[${i}:${frozen[i].name}]` : `${at}[${i}]`;
      out.push(...diff(frozen[i], actual[i], label));
    }
    return out;
  }
  if (isObj(frozen) && isObj(actual) && !Array.isArray(frozen) && !Array.isArray(actual)) {
    const out = [];
    for (const k of new Set([...Object.keys(frozen), ...Object.keys(actual)])) {
      const p = at ? `${at}.${k}` : k;
      if (!(k in actual)) out.push(`${p}: missing (frozen has it)`);
      else if (!(k in frozen)) out.push(`${p}: not in the frozen interface`);
      else out.push(...diff(frozen[k], actual[k], p));
    }
    return out;
  }
  return [`${at}: ${JSON.stringify(actual)}, frozen ${JSON.stringify(frozen)}`];
}

function main() {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node interfaces/tools/check-idl.mjs <path to an anchor IDL json>');
    process.exit(2);
  }
  const frozen = JSON.parse(readFileSync(frozenPath, 'utf8'));
  const actual = JSON.parse(readFileSync(file, 'utf8'));
  const problems = diff(normalize(frozen), normalize(actual));
  // `declare_id!` MUST equal interfaces/solana/program-id.txt (SPEC 4).
  const programId = readFileSync(programIdPath, 'utf8').trim();
  if (actual.address !== programId) problems.push(`address: ${actual.address}, program-id.txt says ${programId}`);
  if (frozen.address !== programId) problems.push(`frozen IDL address ${frozen.address} differs from program-id.txt ${programId}`);
  if (problems.length) {
    console.error(`check-idl: ${file} differs from the frozen interface (${problems.length} difference${problems.length === 1 ? '' : 's'}):`);
    for (const p of problems.slice(0, 200)) console.error('  ' + p);
    if (problems.length > 200) console.error(`  … and ${problems.length - 200} more`);
    console.error('An interface change is a request against work package 1; do not edit interfaces/.');
    process.exit(1);
  }
  const n = normalize(actual);
  console.log(
    `check-idl: OK (${Object.keys(n.instructions).length} instructions, ${Object.keys(n.accounts).length} accounts, ` +
      `${Object.keys(n.events).length} events, ${n.errors.length} errors, ${Object.keys(n.types).length} types)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
