// Client for a running svm-rpc: the `svm_*` control methods of docs/SPEC.md 9.2 and polling
// confirmation helpers. No Node-only imports, so browser tests can use it too.

/** Solana cluster genesis hashes. svm-rpc reports none of these. */
export const REAL_GENESIS_HASHES = Object.freeze({
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
});

export class SvmRpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error.message}`);
    this.name = 'SvmRpcError';
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
}

const str = (v) => (typeof v === 'string' ? v : typeof v?.toBase58 === 'function' ? v.toBase58() : String(v));
// Amounts travel as decimal strings: a u64 does not fit a JSON number.
const amount = (v) => BigInt(v).toString();

function assertLoopback(url) {
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    throw new Error(`svm-rpc client refuses ${url}: the fixture is loopback-only and this is not a loopback http URL`);
  }
}

export class SvmRpcClient {
  #id = 0;

  constructor(url) {
    assertLoopback(url);
    this.url = url;
  }

  /** One JSON-RPC call; throws SvmRpcError on an error response. */
  async call(method, params = []) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    if (body.error) throw new SvmRpcError(method, body.error);
    return body.result;
  }

  addProgram(programId, soPath) {
    return this.call('svm_addProgram', [str(programId), soPath]);
  }

  async setUpgradeAuthority(programId, authority) {
    await this.call('svm_setUpgradeAuthority', [str(programId), authority == null ? null : str(authority)]);
  }

  async airdrop(pubkey, lamports) {
    return BigInt(await this.call('svm_airdrop', [str(pubkey), amount(lamports)]));
  }

  warp(seconds) {
    return this.call('svm_warp', [amount(seconds)]);
  }

  setClock(unixTimestamp) {
    return this.call('svm_setClock', [BigInt(unixTimestamp).toString()]);
  }

  createMint(decimals, authority, mint) {
    return this.call('svm_createMint', mint == null ? [decimals, str(authority)] : [decimals, str(authority), str(mint)]);
  }

  mintTo(mint, owner, value) {
    return this.call('svm_mintTo', [str(mint), str(owner), amount(value)]);
  }

  async setTokenAccountFrozen(tokenAccount, frozen) {
    await this.call('svm_setTokenAccountFrozen', [str(tokenAccount), frozen]);
  }

  async setAccount(pubkey, account) {
    const spec =
      account == null
        ? null
        : {
            lamports: amount(account.lamports),
            owner: account.owner == null ? undefined : str(account.owner),
            data: account.data == null ? undefined : toBase64(account.data),
            executable: account.executable ?? false,
          };
    await this.call('svm_setAccount', [str(pubkey), spec]);
  }

  createLookupTable(addresses, authority) {
    const list = addresses.map(str);
    return this.call('svm_createLookupTable', authority == null ? [list] : [list, str(authority)]);
  }
}

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Waits until `signature` has landed, by polling `getSignatureStatuses`. svm-rpc has no
 * WebSocket, so web3.js `confirmTransaction` / `sendAndConfirmTransaction` cannot be used.
 * Resolves with the status (check `err`); rejects after `timeoutMs` if it never lands.
 */
export async function confirmSignature(connection, signature, { timeoutMs = 10_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    if (value[0]) return value[0];
    if (Date.now() >= deadline) throw new Error(`transaction ${signature} did not land within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Sends a fully signed transaction (legacy or versioned) and waits for it by polling.
 * Throws if the transaction landed with an error. Returns the signature.
 */
export async function sendAndConfirm(connection, transaction, options = {}) {
  const signature = await connection.sendRawTransaction(transaction.serialize(), options);
  const status = await confirmSignature(connection, signature, options);
  if (status.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
  return signature;
}
