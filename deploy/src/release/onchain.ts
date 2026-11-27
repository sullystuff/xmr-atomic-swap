/**
 * The executable hash of a program as it sits on-chain, read through a Solana JSON-RPC endpoint
 * the user names. It is the same value `solana-verify get-program-hash -u <url> <program id>`
 * prints: the SHA-256 of the program's bytes with the trailing zero padding removed.
 *
 * Read-only: two `getAccountInfo` calls, no wallet, no transaction. The URL is never printed.
 */
import { base58Decode, base58Encode } from '@xmrswap/protocol';
import { executableHash } from '../../scripts/sums.mjs';

export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const LOADER_V2 = 'BPFLoader2111111111111111111111111111111111';
/** Bytes before the program in a ProgramData account: tag (4), slot (8), optional authority (1 + 32). */
export const PROGRAMDATA_HEADER = 45;

export class OnchainError extends Error {}

export type OnchainProgram =
  | { found: false }
  | {
      found: true;
      loader: 'upgradeable' | 'v2';
      executable_hash: string;
      /** Size of the program bytes, padding included. */
      size: number;
      /** The key that can replace the program; `null` when the program is immutable. */
      upgrade_authority: string | null;
      /** Slot of the last deployment or upgrade (upgradeable loader only). */
      last_deployed_slot: number | null;
    };

interface AccountInfo {
  data: [string, string];
  executable: boolean;
  owner: string;
}

async function getAccount(rpcUrl: string, address: string, fetchFn: typeof fetch): Promise<AccountInfo | null> {
  let res: Response;
  try {
    res = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'base64', commitment: 'finalized' }] }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    throw new OnchainError(`the RPC endpoint is not reachable (${err.name === 'TimeoutError' ? 'no answer within 30 s' : (err.cause?.code ?? 'network error')})`);
  }
  if (!res.ok) throw new OnchainError(`the RPC endpoint answered HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { result?: { value: AccountInfo | null }; error?: { message?: string } } | null;
  if (!body) throw new OnchainError('the RPC endpoint did not answer with JSON');
  if (body.error) throw new OnchainError(`getAccountInfo was refused: ${String(body.error.message)}`);
  return body.result?.value ?? null;
}

/** Read the program at `programId` and hash its executable bytes. */
export async function fetchProgramHash(rpcUrl: string, programId: string, fetchFn: typeof fetch = fetch): Promise<OnchainProgram> {
  const account = await getAccount(rpcUrl, programId, fetchFn);
  if (account === null) return { found: false };
  const data = Buffer.from(account.data[0], 'base64');
  if (!account.executable) throw new OnchainError(`${programId} exists but is not a program (the account is not executable)`);
  if (account.owner === LOADER_V2) return { found: true, loader: 'v2', executable_hash: executableHash(data), size: data.length, upgrade_authority: null, last_deployed_slot: null };
  if (account.owner !== UPGRADEABLE_LOADER) throw new OnchainError(`${programId} is owned by ${account.owner}, a loader this tool does not read`);
  // UpgradeableLoaderState::Program { programdata_address }
  if (data.length < 36 || data.readUInt32LE(0) !== 2) throw new OnchainError(`${programId} is not a deployed program account`);
  const programData = base58Encode(data.subarray(4, 36));
  const pd = await getAccount(rpcUrl, programData, fetchFn);
  if (pd === null) throw new OnchainError(`the program's data account ${programData} does not exist (the program was closed)`);
  const bytes = Buffer.from(pd.data[0], 'base64');
  // UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address }, then the program.
  if (pd.owner !== UPGRADEABLE_LOADER || bytes.length < PROGRAMDATA_HEADER || bytes.readUInt32LE(0) !== 3) throw new OnchainError(`${programData} is not a program data account`);
  const slot = Number(bytes.readBigUInt64LE(4));
  const authority = bytes[12] === 1 ? base58Encode(bytes.subarray(13, 45)) : null;
  const program = bytes.subarray(PROGRAMDATA_HEADER);
  return { found: true, loader: 'upgradeable', executable_hash: executableHash(program), size: program.length, upgrade_authority: authority, last_deployed_slot: slot };
}

export function isProgramId(value: string): boolean {
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}
