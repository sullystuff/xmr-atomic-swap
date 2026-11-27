/**
 * Wallet connection. Solana: wallet-adapter with Wallet Standard discovery only, so the bundle
 * carries no vendor SDK and makes no third-party request. Ethereum: the injected EIP-1193
 * provider. A wallet signs the one lock transaction; everything later is the session key.
 */
import type { WalletName } from '@solana/wallet-adapter-base';
import { WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import type { Transaction } from '@solana/web3.js';
import type { Address, Hex } from '@xmrswap/protocol';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { wrongWalletChain } from '../lib/errors.js';
import { shorten } from '../lib/format.js';
import { useApp, useObs } from './hooks.js';

function SolanaBridge() {
  const app = useApp();
  const { publicKey, signTransaction, signMessage, connected } = useWallet();
  useEffect(() => {
    // `signMessage` exists only when the wallet has the Wallet Standard feature `solana:signMessage`.
    if (connected && publicKey && signTransaction) app.setWallet('solana', { address: publicKey.toBase58(), signTransaction: (tx: Transaction) => signTransaction(tx), ...(signMessage ? { signMessage: (m: Uint8Array) => signMessage(m) } : {}) });
    else app.setWallet('solana', null);
  }, [app, connected, publicKey, signTransaction, signMessage]);
  return null;
}

export function Wallets({ children }: { children: ReactNode }) {
  return (
    <WalletProvider wallets={[]} autoConnect onError={() => undefined}>
      <SolanaBridge />
      {children}
    </WalletProvider>
  );
}

export function SolanaWalletButton() {
  const { wallets, wallet, select, connect, disconnect, connected, connecting, publicKey } = useWallet();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wanted, setWanted] = useState<WalletName | null>(null);
  // `select` only records the choice; connect once the adapter is the selected one.
  useEffect(() => {
    if (wanted && wallet?.adapter.name === wanted && !connected && !connecting) {
      setWanted(null);
      connect().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [wanted, wallet, connected, connecting, connect]);
  const choose = (name: WalletName) => {
    setError(null);
    setOpen(false);
    select(name);
    setWanted(name);
  };
  if (connected && publicKey)
    return (
      <button type="button" className="btn btn-sm" onClick={() => void disconnect()} title={`${publicKey.toBase58()} (click to disconnect)`}>
        <span className="faint">Solana</span> <span className="mono">{shorten(publicKey.toBase58(), 4, 4)}</span>
      </button>
    );
  const usable = wallets.filter((w) => w.readyState === 'Installed' || w.readyState === 'Loadable');
  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="btn btn-sm"
        aria-expanded={open}
        disabled={connecting}
        onClick={() => (usable.length === 1 ? choose(usable[0]!.adapter.name) : setOpen((o) => !o))}
      >
        {connecting ? 'Connecting…' : 'Connect Solana'}
      </button>
      {open ? (
        <div className="panel absolute right-0 top-full mt-1 w-64 p-2 z-20" role="menu" aria-label="Solana wallets">
          {usable.length === 0 ? (
            <p className="p-2 text-sm muted">No Solana wallet was found in this browser. Install a wallet extension that supports the Wallet Standard, then reload.</p>
          ) : (
            usable.map((w) => (
              <button key={w.adapter.name} type="button" role="menuitem" className="btn btn-quiet btn-sm w-full !justify-start" onClick={() => choose(w.adapter.name)}>
                {w.adapter.name}
              </button>
            ))
          )}
        </div>
      ) : null}
      {error ? (
        <span className="sr-only" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

interface Eip1193 {
  request(a: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...a: unknown[]) => void): void;
  removeListener?(event: string, handler: (...a: unknown[]) => void): void;
}
const injected = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;

export function EthereumWalletButton() {
  const app = useApp();
  const wallets = useObs(app.wallets);
  const settings = useObs(app.settings);
  const [error, setError] = useState<string | null>(null);
  const adopt = useCallback(
    (accounts: unknown) => {
      const provider = injected();
      const a = Array.isArray(accounts) && typeof accounts[0] === 'string' ? (accounts[0] as Address) : null;
      if (!a || !provider) {
        app.setWallet('ethereum', null);
        return;
      }
      app.setWallet('ethereum', {
        address: a,
        sendTransaction: async (call) => {
          const chain = Number.parseInt((await provider.request({ method: 'eth_chainId' })) as string, 16);
          const want = app.settings.get().ethereumChainId;
          // A transaction signed for another network would lock nothing here and could be replayed nowhere useful: refuse.
          if (chain !== want) throw new Error(wrongWalletChain(chain, want));
          return (await provider.request({ method: 'eth_sendTransaction', params: [{ from: a, to: call.to, data: call.data, value: `0x${call.value.toString(16)}` }] })) as Hex;
        },
      });
    },
    [app],
  );
  useEffect(() => {
    const p = injected();
    if (!p?.on) return;
    p.on('accountsChanged', adopt);
    // Reconnect silently when the wallet already trusts this site.
    void p.request({ method: 'eth_accounts' }).then(adopt, () => undefined);
    return () => p.removeListener?.('accountsChanged', adopt);
  }, [adopt]);
  if (!settings.ethereumRpc) return null;
  if (wallets.ethereum)
    return (
      <button type="button" className="btn btn-sm" onClick={() => app.setWallet('ethereum', null)} title={`${wallets.ethereum.address} (click to disconnect)`}>
        <span className="faint">Ethereum</span> <span className="mono">{shorten(wallets.ethereum.address, 6, 4)}</span>
      </button>
    );
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          const p = injected();
          if (!p) {
            setError('No Ethereum wallet was found in this browser.');
            return;
          }
          setError(null);
          p.request({ method: 'eth_requestAccounts' }).then(adopt, (e: unknown) => setError(e instanceof Error ? e.message : 'The wallet refused the connection.'));
        }}
      >
        Connect Ethereum
      </button>
      {error ? (
        <span className="text-sm text-danger-text" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
