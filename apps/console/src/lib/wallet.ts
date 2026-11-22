/**
 * Owner-key signing in the browser (SPEC 8.1): the daemon builds an unsigned transaction, the
 * owner's own wallet signs it, the daemon relays it. The console never sees a private key and
 * never talks to a chain itself.
 *
 * Solana wallets are found through the Wallet Standard events; Ethereum through the injected
 * EIP-1193 provider. Neither needs a library.
 */
import type { UnsignedTransaction } from '@xmrswap/protocol/daemon-api';

export interface OwnerSigner {
  chain: 'solana' | 'ethereum';
  name: string;
  /** Returns the signed transaction in the form `POST /api/registration/submit` takes. */
  sign(unsigned: UnsignedTransaction): Promise<string>;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Number of signatures a serialised Solana message requires (legacy, or v0 with its 0x80 prefix). */
export function requiredSignatures(message: Uint8Array): number {
  const first = message[0];
  if (first === undefined) throw new Error('empty message');
  const n = first & 0x80 ? message[1] : first;
  if (n === undefined || n === 0 || n > 16) throw new Error('not a Solana message');
  return n;
}

/** Wire form of an unsigned Solana transaction: the signature count, that many empty signatures, then the message. */
export function unsignedSolanaTransaction(messageB64: string): Uint8Array {
  const message = fromBase64(messageB64);
  const n = requiredSignatures(message);
  const out = new Uint8Array(1 + 64 * n + message.length);
  out[0] = n; // compact-u16 of a value below 128 is one byte
  out.set(message, 1 + 64 * n);
  return out;
}

// ------------------------------------------------------------------ Solana: Wallet Standard

interface StandardAccount {
  address: string;
}
interface StandardWallet {
  name: string;
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
}
type ConnectFeature = { connect(): Promise<{ accounts: readonly StandardAccount[] }> };
type SignFeature = { signTransaction(...inputs: { account: StandardAccount; transaction: Uint8Array; chain?: string }[]): Promise<{ signedTransaction: Uint8Array }[]> };

function solanaSigner(wallet: StandardWallet): OwnerSigner | null {
  const sign = wallet.features['solana:signTransaction'] as SignFeature | undefined;
  if (!sign) return null;
  return {
    chain: 'solana',
    name: wallet.name,
    async sign(unsigned) {
      if (unsigned.chain !== 'solana') throw new Error('This wallet signs Solana transactions only.');
      let accounts = wallet.accounts;
      const connect = wallet.features['standard:connect'] as ConnectFeature | undefined;
      if (accounts.length === 0 && connect) accounts = (await connect.connect()).accounts;
      const account = accounts.find((a) => a.address === unsigned.fee_payer);
      if (!account) throw new Error(`${wallet.name} does not hold the owner key ${unsigned.fee_payer}. Switch to that account in the wallet and try again.`);
      const [out] = await sign.signTransaction({ account, transaction: unsignedSolanaTransaction(unsigned.message_b64) });
      if (!out) throw new Error(`${wallet.name} returned nothing.`);
      return toBase64(out.signedTransaction);
    },
  };
}

// ------------------------------------------------------------------ Ethereum: EIP-1193

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function ethereumSigner(provider: Eip1193): OwnerSigner {
  return {
    chain: 'ethereum',
    name: 'Browser wallet',
    async sign(unsigned) {
      if (unsigned.chain !== 'ethereum') throw new Error('This wallet signs Ethereum transactions only.');
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      const from = accounts[0];
      if (!from) throw new Error('The wallet exposed no account.');
      const chainId = (await provider.request({ method: 'eth_chainId' })) as string;
      if (Number(chainId) !== unsigned.chain_id) throw new Error(`The wallet is on chain ${Number(chainId)}; this transaction is for chain ${unsigned.chain_id}.`);
      try {
        const raw = await provider.request({
          method: 'eth_signTransaction',
          params: [{ from, to: unsigned.to, data: unsigned.data, value: `0x${BigInt(unsigned.value).toString(16)}`, chainId: `0x${unsigned.chain_id.toString(16)}` }],
        });
        const hex = typeof raw === 'string' ? raw : (raw as { raw?: string } | null)?.raw;
        if (typeof hex !== 'string' || !hex.startsWith('0x')) throw new Error('The wallet did not return a signed transaction.');
        return hex;
      } catch (e) {
        const code = (e as { code?: number } | null)?.code;
        if (code === 4200 || code === -32601 || code === -32004) {
          throw new Error('This wallet will not sign without broadcasting. Sign the transaction below with a tool that returns the raw signed transaction (a hardware-wallet CLI, for example) and paste it.');
        }
        throw e;
      }
    },
  };
}

/**
 * Find the owner's wallets. `onChange` fires as wallets announce themselves (they may load after
 * the page). Returns the function that stops listening.
 */
export function watchSigners(onChange: (signers: OwnerSigner[]) => void, win: Window = window): () => void {
  const wallets = new Set<StandardWallet>();
  const emit = (): void => {
    const out: OwnerSigner[] = [];
    for (const w of wallets) {
      const s = solanaSigner(w);
      if (s) out.push(s);
    }
    const eth = (win as unknown as { ethereum?: Eip1193 }).ethereum;
    if (eth && typeof eth.request === 'function') out.push(ethereumSigner(eth));
    onChange(out);
  };
  const api = {
    register: (...ws: StandardWallet[]) => {
      for (const w of ws) wallets.add(w);
      emit();
      return () => undefined;
    },
  };
  const onRegister = (e: Event): void => {
    const cb = (e as CustomEvent<(a: typeof api) => void>).detail;
    if (typeof cb === 'function') cb(api);
  };
  win.addEventListener('wallet-standard:register-wallet', onRegister);
  win.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  emit();
  return () => win.removeEventListener('wallet-standard:register-wallet', onRegister);
}
