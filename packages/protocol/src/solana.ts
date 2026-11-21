/**
 * Solana account, event and instruction codecs, driven by the tables generated from the frozen
 * IDL (`generated/solana.ts`). Public keys are base58 strings.
 */
import { BorshError, Reader, Writer, bytesEqual } from './borsh.js';
import {
  ACCOUNTS,
  type AccountMeta,
  type AccountName,
  type AccountTypes,
  ERROR_CODE_BASE,
  ERROR_NAMES,
  EVENTS,
  type EventName,
  type EventTypes,
  INSTRUCTIONS,
  type InstructionArgs,
  type InstructionName,
  type ProgramErrorName,
} from './generated/solana.js';

export * from './generated/solana.js';

/** Which account type a buffer holds, by its 8-byte discriminator; `null` if none. */
export function accountNameOf(data: Uint8Array): AccountName | null {
  if (data.length < 8) return null;
  const head = data.subarray(0, 8);
  for (const name of Object.keys(ACCOUNTS) as AccountName[]) if (bytesEqual(ACCOUNTS[name].discriminator, head)) return name;
  return null;
}

/**
 * Decode an account's data. Checks the discriminator. Bytes after the last field are ignored:
 * accounts are allocated at their full size (`Maker` keeps spare room for its variable tail).
 */
export function decodeAccount<N extends AccountName>(name: N, data: Uint8Array): AccountTypes[N] {
  const { discriminator, codec } = ACCOUNTS[name];
  if (data.length < 8 || !bytesEqual(discriminator, data.subarray(0, 8))) throw new BorshError(`not a ${name} account`);
  return codec.read(new Reader(data.subarray(8))) as AccountTypes[N];
}

/** Encode an account as the program stores it, zero-padded to `size` when given (tests, fixtures). */
export function encodeAccount<N extends AccountName>(name: N, value: AccountTypes[N], size?: number): Uint8Array {
  const { discriminator, codec } = ACCOUNTS[name];
  const w = new Writer();
  w.raw(discriminator);
  (codec as { write(w: Writer, v: unknown): void }).write(w, value);
  const out = w.finish();
  if (size === undefined) return out;
  if (out.length > size) throw new BorshError(`${name} needs ${out.length} bytes, more than ${size}`);
  const padded = new Uint8Array(size);
  padded.set(out);
  return padded;
}

export type DecodedEvent = { [N in EventName]: { name: N; data: EventTypes[N] } }[EventName];

/** Decode one `emit!` payload (the bytes after `Program data: `, base64-decoded); `null` if it is not one of ours. */
export function decodeEvent(payload: Uint8Array): DecodedEvent | null {
  if (payload.length < 8) return null;
  const head = payload.subarray(0, 8);
  for (const name of Object.keys(EVENTS) as EventName[]) {
    const { discriminator, codec } = EVENTS[name];
    if (!bytesEqual(discriminator, head)) continue;
    const r = new Reader(payload.subarray(8));
    const data = codec.read(r);
    if (r.remaining !== 0) throw new BorshError(`${name}: ${r.remaining} trailing bytes`);
    return { name, data } as DecodedEvent;
  }
  return null;
}

export function encodeEvent<N extends EventName>(name: N, data: EventTypes[N]): Uint8Array {
  const { discriminator, codec } = EVENTS[name];
  const w = new Writer();
  w.raw(discriminator);
  (codec as { write(w: Writer, v: unknown): void }).write(w, data);
  return w.finish();
}

const LOG_PREFIX = 'Program data: ';
function fromBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Every event of this program in a transaction's log lines. Lines that are not base64, or carry
 * another program's data, are skipped. Events are an index only: nothing a party needs for
 * safety lives only in an event.
 */
export function parseEventLogs(logs: readonly string[]): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith(LOG_PREFIX)) continue;
    const payload = fromBase64(line.slice(LOG_PREFIX.length));
    if (!payload) continue;
    try {
      const ev = decodeEvent(payload);
      if (ev) out.push(ev);
    } catch {
      // A foreign payload that happens to share a discriminator prefix.
    }
  }
  return out;
}

/** Instruction data: the 8-byte discriminator followed by the Borsh arguments. */
export function encodeInstructionData<N extends InstructionName>(name: N, args: InstructionArgs[N]): Uint8Array {
  const { discriminator, args: codec } = INSTRUCTIONS[name];
  const w = new Writer();
  w.raw(discriminator);
  (codec as { write(w: Writer, v: unknown): void }).write(w, args);
  return w.finish();
}

/** Which instruction a data buffer invokes, with its decoded arguments; `null` if none of ours. */
export function decodeInstructionData(data: Uint8Array): { [N in InstructionName]: { name: N; args: InstructionArgs[N] } }[InstructionName] | null {
  if (data.length < 8) return null;
  const head = data.subarray(0, 8);
  for (const name of Object.keys(INSTRUCTIONS) as InstructionName[]) {
    const ix = INSTRUCTIONS[name];
    if (!bytesEqual(ix.discriminator, head)) continue;
    const r = new Reader(data.subarray(8));
    const args = ix.args.read(r);
    if (r.remaining !== 0) throw new BorshError(`${name}: ${r.remaining} trailing bytes`);
    return { name, args } as never;
  }
  return null;
}

/** The account list of an instruction, in order, with signer, writable and optional flags. */
export function instructionAccounts(name: InstructionName): readonly AccountMeta[] {
  return INSTRUCTIONS[name].accounts;
}

/** Name of a custom program error code (`6000 + index`), or `null`. */
export function errorName(code: number): ProgramErrorName | null {
  return ERROR_NAMES[code - ERROR_CODE_BASE] ?? null;
}
/** Custom error code of an error name. */
export function errorCode(name: ProgramErrorName): number {
  return ERROR_CODE_BASE + ERROR_NAMES.indexOf(name);
}
