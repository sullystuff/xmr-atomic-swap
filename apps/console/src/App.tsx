/** The console shell: top bar, navigation, routing by URL hash, and the connect screen. */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { DaemonClient, describeError, type FetchLike, type SocketFactory } from './api/client.js';
import { DaemonProvider, useAction, useClient, useLive, useToasts, type Clock } from './api/hooks.js';
import { ConfigPage } from './pages/config/ConfigPage.js';
import { InventoryPage, OffersPage, RebalancingPage } from './pages/market.js';
import { ApprovalsPage, DashboardPage, DepositsPage, InboxPage, SwapDetailPage, SwapsPage } from './pages/monitor.js';
import { KeysPage, RegistrationPage, StatusPage } from './pages/setup.js';
import { UpgradeBadge, upgradeLine, upgradeStateOf, upgradeSummary } from './ui/domain.js';
import { Badge, Button, ConfirmButton, Notice } from './ui/kit.js';

// ------------------------------------------------------------------ routing

export type PageId = 'dashboard' | 'swaps' | 'approvals' | 'deposits' | 'inbox' | 'offers' | 'inventory' | 'rebalancing' | 'config' | 'registration' | 'keys' | 'status';
const NAV: { title: string; pages: { id: PageId; label: string }[] }[] = [
  {
    title: 'Monitor',
    pages: [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'swaps', label: 'Swaps' },
      { id: 'approvals', label: 'Approvals' },
      { id: 'deposits', label: 'Deposits' },
      { id: 'inbox', label: 'Inbox' },
    ],
  },
  {
    title: 'Market',
    pages: [
      { id: 'offers', label: 'Offers' },
      { id: 'inventory', label: 'Inventory' },
      { id: 'rebalancing', label: 'Rebalancing' },
    ],
  },
  {
    title: 'Setup',
    pages: [
      { id: 'config', label: 'Configuration' },
      { id: 'registration', label: 'Registration' },
      { id: 'keys', label: 'Keys' },
      { id: 'status', label: 'Status' },
    ],
  },
];
const PAGE_IDS = NAV.flatMap((g) => g.pages.map((p) => p.id));

export function parseRoute(hash: string): { page: PageId; arg: string | undefined } {
  const [, page = '', ...rest] = hash.replace(/^#/, '').split('/');
  const arg = rest.length > 0 ? decodeURIComponent(rest.join('/')) : undefined;
  return { page: (PAGE_IDS as string[]).includes(page) ? (page as PageId) : 'dashboard', arg: arg === '' ? undefined : arg };
}
function useRoute(): { page: PageId; arg: string | undefined } {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = (): void => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return useMemo(() => parseRoute(hash), [hash]);
}

// ------------------------------------------------------------------ theme

type Theme = 'system' | 'dark' | 'light';
const THEME_KEY = 'maker-console.theme';
function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = window.localStorage.getItem(THEME_KEY);
      return t === 'dark' || t === 'light' ? t : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'system') window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
  }, [theme]);
  return [theme, setTheme];
}

// ------------------------------------------------------------------ shell

function PauseControl() {
  const client = useClient();
  const { status, refresh } = useLive();
  const { busy, run } = useAction();
  if (!status) return null;
  const { owner, operator, guardrails } = status.paused;
  const done = (): void => refresh();
  if (operator) {
    return (
      <span className="topbar-item">
        <Badge tone="warn">Paused</Badge>
        <Button small busy={busy === 'resume'} onClick={() => void run('resume', () => client.call('resume'), (r) => (r.paused ? 'The pause switch is off, but the owner key still has this maker paused.' : 'Resumed: offers are refreshed again.')).then(done)}>
          Resume
        </Button>
      </span>
    );
  }
  return (
    <span className="topbar-item">
      {owner ? <Badge tone="warn">Paused by the owner key</Badge> : guardrails.length > 0 ? <Badge tone="warn" title={guardrails.join(', ')}>Paused by a guardrail</Badge> : <Badge tone="ok">Quoting</Badge>}
      <ConfirmButton label="Pause" small variant="danger" busy={busy === 'pause'} onConfirm={() => void run('pause', () => client.call('pause', { body: {} }), 'Paused: no new swaps can start. Open swaps keep running.').then(done)}>
        Stop quoting on both chains now. Swaps that are already open keep running to their end.
      </ConfirmButton>
      <ConfirmButton
        label="Pause and revoke"
        confirmLabel="Pause and revoke all"
        small
        variant="danger"
        busy={busy === 'pause-bump'}
        onConfirm={() => void run('pause-bump', () => client.call('pause', { body: { bump_epochs: true } }), 'Paused, and every outstanding advance approval and signed quote is dead.').then(done)}
      >
        Stop quoting and bump the epochs, which kills every outstanding advance approval and signed quote. Use this if the operator key may be exposed.
      </ConfirmButton>
    </span>
  );
}

function TopBar({ theme, setTheme, onDisconnect }: { theme: Theme; setTheme: (t: Theme) => void; onDisconnect?: (() => void) | undefined }) {
  const { status, connection } = useLive();
  const id = useId();
  const up = status ? upgradeSummary(status.chains) : null;
  return (
    <header className="topbar">
      <span className="brand">
        <span className="brand-mark" aria-hidden="true" />
        Maker console
      </span>
      {status ? <span className="topbar-item">{status.mode === 'live' ? <Badge tone="accent">Live</Badge> : <Badge tone="info" title="Offers and decisions are computed and shown; no transaction is sent and no XMR moves">Dry run</Badge>}</span> : null}
      <PauseControl />
      <span className="spacer" />
      {up ? (
        <a className="topbar-item" href="#/status" data-testid="upgrade-badge" title={up.text}>
          <Badge tone={up.tone}>{up.short}</Badge>
        </a>
      ) : null}
      {status ? (
        <span className="topbar-item" data-testid="upgrade-chains">
          {status.chains.map((c) => (
            <UpgradeBadge key={c.chain} chain={c} />
          ))}
        </span>
      ) : null}
      <span className="topbar-item" role="status" aria-label="Connection to the daemon">
        <Badge tone={connection === 'live' ? 'ok' : connection === 'connecting' ? 'info' : 'bad'}>{connection === 'live' ? 'Daemon: live' : connection === 'connecting' ? 'Daemon: connecting' : 'Daemon: no live link'}</Badge>
      </span>
      <span className="topbar-item">
        <label htmlFor={id} className="muted">
          Theme
        </label>
        <select id={id} value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </span>
      {onDisconnect ? (
        <Button small variant="ghost" onClick={onDisconnect}>
          Disconnect
        </Button>
      ) : null}
    </header>
  );
}

function Sidebar({ page }: { page: PageId }) {
  const { swaps, inbox, status } = useLive();
  const counts: Partial<Record<PageId, { n: number; label: string; hot: boolean }>> = {};
  if (swaps) {
    const pending = swaps.filter((s) => s.state === 'PENDING').length;
    const held = swaps.filter((s) => s.state === 'HOLD').length;
    if (pending > 0) counts.approvals = { n: pending, label: `${pending} waiting for approval`, hot: true };
    if (held > 0) counts.deposits = { n: held, label: `${held} in the 30-minute hold`, hot: true };
  }
  if (status && status.needs_review > 0) counts.swaps = { n: status.needs_review, label: `${status.needs_review} parked for review`, hot: true };
  if (inbox) {
    const unread = inbox.filter((m) => m.direction === 'in' && !m.read).length;
    if (unread > 0) counts.inbox = { n: unread, label: `${unread} unread`, hot: false };
  }
  return (
    <nav className="sidebar" aria-label="Pages">
      {NAV.map((g) => (
        <div className="nav-group" key={g.title}>
          <h2>{g.title}</h2>
          <ul>
            {g.pages.map((p) => {
              const c = counts[p.id];
              return (
                <li key={p.id}>
                  <a className="nav-link" href={`#/${p.id}`} aria-current={p.id === page ? 'page' : undefined}>
                    {p.label}
                    {c ? (
                      <span className={`count${c.hot ? ' hot' : ''}`} title={c.label}>
                        {c.n}
                        <span className="sr-only"> ({c.label})</span>
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`notice toast ${t.tone}`}>
          <span>{t.text}</span>
          <Button small variant="ghost" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  );
}

function Page({ page, arg }: { page: PageId; arg: string | undefined }): ReactNode {
  switch (page) {
    case 'dashboard':
      return <DashboardPage />;
    case 'swaps':
      return arg ? <SwapDetailPage key={arg} swapRef={arg} /> : <SwapsPage />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'deposits':
      return <DepositsPage />;
    case 'inbox':
      return <InboxPage key={arg ?? ''} {...(arg ? { selected: arg } : {})} />;
    case 'offers':
      return <OffersPage />;
    case 'inventory':
      return <InventoryPage />;
    case 'rebalancing':
      return <RebalancingPage />;
    case 'config':
      return <ConfigPage />;
    case 'registration':
      return <RegistrationPage />;
    case 'keys':
      return <KeysPage />;
    case 'status':
      return <StatusPage />;
  }
}

function Shell({ onDisconnect }: { onDisconnect?: (() => void) | undefined }) {
  const { page, arg } = useRoute();
  const [theme, setTheme] = useTheme();
  const { status, statusError } = useLive();
  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to the page
      </a>
      <TopBar theme={theme} setTheme={setTheme} onDisconnect={onDisconnect} />
      <Sidebar page={page} />
      <main className="main" id="main" tabIndex={-1}>
        {statusError && !status ? (
          <div style={{ marginBottom: 12 }}>
            <Notice tone="bad" title="No answer from the daemon.">
              {describeError(statusError)}
            </Notice>
          </div>
        ) : null}
        {status && status.chains.some((c) => upgradeStateOf(c) !== 'immutable') ? (
          <div className={`upgrade-strip ${upgradeSummary(status.chains).tone}`} role="note" aria-label="Contract upgrade status" data-testid="upgrade-strip">
            <strong>{upgradeSummary(status.chains).short}.</strong>
            <ul>
              {status.chains.map((c) => (
                <li key={c.chain}>{upgradeLine(c)}</li>
              ))}
            </ul>
            <a href="#/status">Details on Status</a>
          </div>
        ) : null}
        {status && status.mode === 'dry_run' ? (
          <div style={{ marginBottom: 12 }}>
            <Notice tone="info" title="Dry run.">
              The daemon computes and shows offers and decisions but sends no transaction and moves no XMR. Switch to live under Configuration, Daemon and connections.
            </Notice>
          </div>
        ) : null}
        <Page page={page} arg={arg} />
      </main>
      <Toasts />
    </div>
  );
}

/** The console against one daemon client. Tests render this with the in-process mock transports. */
export function Console({ client, clock, onUnauthorized, onDisconnect }: { client: DaemonClient; clock?: Clock; onUnauthorized?: () => void; onDisconnect?: () => void }) {
  return (
    <DaemonProvider client={client} {...(clock ? { clock } : {})} {...(onUnauthorized ? { onUnauthorized } : {})}>
      <Shell onDisconnect={onDisconnect} />
    </DaemonProvider>
  );
}

// ------------------------------------------------------------------ connect

const TOKEN_KEY = 'maker-console.token';

/** Asks for the daemon's access token, then runs the console. The token lives in this tab's session storage only. */
export function Root({ baseUrl = '', initialToken, fetch, socket }: { baseUrl?: string; initialToken?: string; fetch?: FetchLike; socket?: SocketFactory }) {
  const [token, setToken] = useState<string | null>(() => {
    if (initialToken) return initialToken;
    try {
      return window.sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  });
  const [draft, setDraft] = useState('');
  const [refused, setRefused] = useState(false);
  const id = useId();
  const client = useMemo(() => (token ? new DaemonClient({ baseUrl, token, ...(fetch ? { fetch } : {}), ...(socket ? { socket } : {}) }) : null), [baseUrl, token, fetch, socket]);
  const forget = (wasRefused: boolean): void => {
    try {
      window.sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing stored */
    }
    setRefused(wasRefused);
    setToken(null);
  };
  if (client) return <Console client={client} onUnauthorized={() => forget(true)} onDisconnect={() => forget(false)} />;
  return (
    <main className="connect">
      <div className="card">
        <div className="card-head">
          <h1>Connect to your daemon</h1>
        </div>
        <form
          className="card-body stack"
          onSubmit={(e) => {
            e.preventDefault();
            const t = draft.trim();
            if (!t) return;
            try {
              window.sessionStorage.setItem(TOKEN_KEY, t);
            } catch {
              /* kept in memory only */
            }
            setRefused(false);
            setDraft('');
            setToken(t);
          }}
        >
          <p>This console talks only to your own daemon on this machine{baseUrl ? ` (${baseUrl})` : ''}. It holds no key and cannot move funds by itself.</p>
          {refused ? (
            <Notice tone="bad" title="The daemon refused that token.">
              Check the token file in the daemon’s keystore directory and try again.
            </Notice>
          ) : null}
          <div className="field">
            <label htmlFor={id}>Access token</label>
            <input id={id} type="password" className="w-wide" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} aria-describedby={`${id}-h`} />
            <p className="help" id={`${id}-h`}>
              The bearer token is in the daemon’s keystore directory. It only authorises the local API and is kept for this browser tab only.
            </p>
          </div>
          <div>
            <button type="submit" className="btn primary" disabled={draft.trim() === ''}>
              Connect
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
