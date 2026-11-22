import { useEffect } from 'react';
import type { App as AppObject } from './lib/app.js';
import { ActivityPage } from './pages/ActivityPage.js';
import { LargePage } from './pages/LargePage.js';
import { MakerPage } from './pages/MakerPage.js';
import { NewSwapPage } from './pages/NewSwapPage.js';
import { OffersPage } from './pages/OffersPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { StatusPage } from './pages/StatusPage.js';
import { SwapPage } from './pages/SwapPage.js';
import { RiskBanner, SafeBanner, SystemNotices } from './ui/Banners.js';
import { AppContext, href, useObs, useRoute, useSafety } from './ui/hooks.js';
import { EthereumWalletButton, SolanaWalletButton, Wallets } from './ui/wallets.js';

const NAV: readonly { path: string; label: string }[] = [
  { path: '', label: 'Offers' },
  { path: 'large', label: 'Large swap' },
  { path: 'activity', label: 'Activity' },
  { path: 'settings', label: 'Settings' },
  { path: 'status', label: 'Status' },
];

function Page() {
  const route = useRoute();
  const [a, b, c] = route.path;
  useEffect(() => {
    document.getElementById('main')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [route.path.join('/')]);
  if (!a) return <OffersPage />;
  if (a === 'swap' && b === 'new' && c) return <NewSwapPage key={c} offerId={c} />;
  if (a === 'swap' && b) return <SwapPage key={b} swapRef={b} />;
  if (a === 'large') return <LargePage key={b ?? 'new'} orderId={b} />;
  if (a === 'activity') return <ActivityPage />;
  if (a === 'maker' && b) return <MakerPage key={b} pda={b} />;
  if (a === 'settings') return <SettingsPage />;
  if (a === 'status') return <StatusPage />;
  return <OffersPage />;
}

function Shell({ app }: { app: AppObject }) {
  const route = useRoute();
  const settings = useObs(app.settings);
  const upgrade = useObs(app.upgrade);
  const safety = useSafety();
  // A swap in progress belongs to Activity; reviewing an offer and a maker's page belong to Offers.
  const section = route.path[0] === 'swap' ? (route.path[1] === 'new' ? '' : 'activity') : route.path[0] === 'maker' ? '' : (route.path[0] ?? '');
  useEffect(() => {
    if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);
  const upgradable = upgrade.solana.frozen === false || upgrade.ethereum.frozen === false;
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:p-2">
        Skip to content
      </a>
      <RiskBanner />
      <SafeBanner />
      <header className="topbar">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 pt-3">
          <a href={href()} className="flex items-center gap-2 font-bold text-ink no-underline" aria-label="XMR atomic swaps, home">
            <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="6" fill="#ff6600" />
              <path d="M7 22V10h3l6 7 6-7h3v12h-3.2v-7.2L16 20.900l-5.800-6.100V22z" fill="#0d0d0d" />
            </svg>
            <span>XMR atomic swaps</span>
          </a>
          <div className="flex flex-wrap items-center gap-2">
            <SolanaWalletButton />
            <EthereumWalletButton />
          </div>
        </div>
        <nav className="nav mx-auto mt-1 max-w-6xl px-2" aria-label="Main">
          {NAV.map((n) => (
            <a key={n.path} href={n.path ? href(n.path) : href()} aria-current={section === n.path ? 'page' : undefined}>
              {n.label}
              {n.path === 'activity' && safety.open.length > 0 ? <span className="num ml-1.5 text-accent-text">{safety.open.length}</span> : null}
            </a>
          ))}
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto grid max-w-6xl gap-6 px-4 py-8 outline-none sm:py-10">
        <SystemNotices />
        <Page />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-6 text-sm muted">
        <hr className="rule mb-4" />
        <p className="prose-w">
          Everything that touches funds runs in this page. The site serves static files and its relay carries ciphertext only: neither holds a key, and neither can rescue a swap.{' '}
          {upgradable ? (
            <>
              The contracts can still be upgraded by the project owner; until they are frozen you are trusting that key holder. <a href={href('status')}>See Status</a>.
            </>
          ) : (
            <a href={href('status')}>Check what this page is connected to</a>
          )}
        </p>
        <p className="mt-2 break-all">
          Program <code>{settings.programId}</code>
          {settings.contract ? (
            <>
              {' '}
              · contract <code>{settings.contract}</code>
            </>
          ) : null}
        </p>
      </footer>
    </>
  );
}

export function Root({ app }: { app: AppObject }) {
  return (
    <AppContext.Provider value={app}>
      <Wallets>
        <Shell app={app} />
      </Wallets>
    </AppContext.Provider>
  );
}
