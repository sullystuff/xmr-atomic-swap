/** Amendment 1 in the interface: the protocol's beta caps, freeze windows, frozen swaps, watchers, the release record. */
import { useEffect, useState } from 'react';
import { CHAIN_CONSTS, MARKET_CHAIN, type Market } from '@xmrswap/protocol';
import type { MarketCaps, MarketDirection, ProgramBuildStatus, SwapDetail, WatcherStatus } from '@xmrswap/protocol/daemon-api';
import type { FrozenBy, ReleaseRecord, StatusX, SwapCost, SwapDetailX } from '../api/extensions.js';
import { useClient } from '../api/hooks.js';
import { capsState, degradedReasons, freezeExposure, type CapsKind, type CapsState } from '../lib/amendment.js';
import { chainLabel } from '../lib/config/schema.js';
import { MARKET_LABEL, MARKET_ORDER, fmtDuration, fmtMarketAmount, fmtTime } from '../lib/format.js';
import { Badge, Countdown, Id, Meter, Notice, Time, type Tone } from './kit.js';

// ------------------------------------------------------------------ caps

const CAPS_BADGE: Record<CapsKind, { label: string; tone: Tone }> = {
  unknown: { label: 'Not readable', tone: 'info' },
  off: { label: 'Caps off', tone: 'plain' },
  not_open: { label: 'Not open yet', tone: 'info' },
  reached: { label: 'Cap reached', tone: 'warn' },
  open: { label: 'Open', tone: 'ok' },
};

/**
 * The protocol's beta caps, per market's asset: the largest swap, the open-value cap, what is
 * open and what is left. Set by the protocol's admin on-chain; there is deliberately no control
 * here, because the maker cannot change them.
 */
export function CapsPanel({ caps }: { caps: readonly MarketCaps[] }) {
  const states = [...caps].sort((a, b) => MARKET_ORDER.indexOf(a.market) - MARKET_ORDER.indexOf(b.market)).map(capsState);
  const allClosed = states.length > 0 && states.every((s) => s.kind === 'not_open');
  return (
    <div data-testid="caps-panel">
      {allClosed ? (
        <div className="card-body">
          <Notice tone="info" title="The protocol is not open yet.">
            Its beta caps are still at zero on every market, so no swap can start. This is how a fresh deployment begins, not a fault of your daemon: the protocol’s admin opens it by setting caps. Your offers are computed and will fill as soon as it does.
          </Notice>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="tbl" aria-label="Protocol beta caps">
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">State</th>
              <th scope="col" className="num">
                Largest swap
              </th>
              <th scope="col" className="num">
                Open now
              </th>
              <th scope="col" className="num">
                Open-value cap
              </th>
              <th scope="col" className="num">
                Headroom
              </th>
            </tr>
          </thead>
          <tbody>
            {states.map((s) => (
              <CapsRow key={s.market} s={s} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted card-body" style={{ paddingTop: 6 }}>
        Beta limits set on-chain by the protocol’s admin, not by you; they cannot be changed from here. They gate only new swaps: a swap that is already open always runs to its end. Your own limits are under Configuration.
      </p>
    </div>
  );
}

function CapsRow({ s }: { s: CapsState }) {
  const f = (v: bigint): string => fmtMarketAmount(s.market, v);
  const b = CAPS_BADGE[s.kind];
  const numbers = s.kind !== 'unknown';
  const capped = s.kind === 'open' || s.kind === 'reached';
  return (
    <tr data-caps={s.kind} className={s.kind === 'reached' ? 'attention' : undefined}>
      <th scope="row">
        {MARKET_LABEL[s.market]}
        <div className="muted" style={{ fontWeight: 400 }}>
          {chainLabel(MARKET_CHAIN[s.market])}
        </div>
      </th>
      <td>
        <Badge tone={b.tone}>{b.label}</Badge> {s.frozen && s.kind !== 'off' ? <Badge tone="info">Fixed for good</Badge> : null}
        <div className="muted" data-testid={`caps-text-${s.market}`}>
          {s.text}
        </div>
      </td>
      <td className="num">{capped ? f(s.maxSwap) : s.kind === 'off' ? <span className="muted">no limit</span> : <span className="muted">{numbers ? f(0n) : 'n/a'}</span>}</td>
      <td className="num">{numbers ? f(s.openValue) : <span className="muted">n/a</span>}</td>
      <td className="num">{capped ? f(s.maxOpen) : s.kind === 'off' ? <span className="muted">no limit</span> : <span className="muted">{numbers ? f(0n) : 'n/a'}</span>}</td>
      <td className="num">
        {capped ? (
          <>
            {f(s.headroom)}
            <Meter value={Number(s.openValue)} max={Number(s.maxOpen)} label={`${MARKET_LABEL[s.market]} open value against the protocol’s cap`} />
          </>
        ) : s.kind === 'off' ? (
          <span className="muted">no limit</span>
        ) : (
          <span className="muted">{numbers ? 'none' : 'n/a'}</span>
        )}
      </td>
    </tr>
  );
}

// ------------------------------------------------------------------ freeze window, beside its setting

/** What a freeze window means for this offer, computed from the offer's own deadlines. */
export function FreezeWindowNote({ market, direction, claimDelaySecs, freezeWindowSecs, depositBps }: { market: Market; direction: MarketDirection; claimDelaySecs: number; freezeWindowSecs: number; depositBps: number }) {
  const e = freezeExposure(claimDelaySecs, freezeWindowSecs);
  const margin = CHAIN_CONSTS[MARKET_CHAIN[market]].marginSecs;
  const off = e.windowSecs === 0;
  return (
    <div className="notice" data-testid="freeze-note" style={{ flexBasis: '100%' }}>
      <p>
        <strong>What a watcher is.</strong> A second machine that follows one swap for a party that may be offline, with a key that lets it do one thing: <em>freeze</em> the swap once, which delays the other side’s claim. It can never move funds, and it can be wrong or down.
      </p>
      {direction === 'sell_xmr' ? (
        <>
          <p style={{ marginTop: 6 }}>
            <strong>What allowing one costs you.</strong> Selling XMR, you are the one who claims. A taker’s watcher (or the taker) may freeze the swap after your lock notice, and your claim without the taker’s ready then waits up to the freeze window instead of opening after your claim delay.
          </p>
          <p style={{ marginTop: 6 }} data-testid="freeze-worst">
            {off ? (
              <>With the window at 0 no taker can name a watcher on this offer. Your XMR is locked at most {fmtDuration(e.withoutSecs)} after your lock notice before you may claim.</>
            ) : (
              <>
                Worst case with this offer’s deadlines: your XMR stays locked for <strong>{fmtDuration(e.worstSecs)}</strong> after your lock notice before you may claim (your claim delay of {fmtDuration(e.withoutSecs)} plus the window of {fmtDuration(e.windowSecs)}), against {fmtDuration(e.withoutSecs)} without a watcher: <strong>{e.times} times longer</strong>. The taker’s own funds are locked for the same time, and it can still walk away during it.
              </>
            )}
          </p>
          <p style={{ marginTop: 6 }}>
            <strong>Your protection.</strong> A refund or abort after a freeze always leaves the deposit withholdable{depositBps === 0 ? ' — and this offer takes no deposit, so there would be nothing to withhold' : ''}. With a window set, the default withhold policy becomes “when the price moved against me”. You can also refuse takers by watcher key under Approval rules.
          </p>
        </>
      ) : (
        <>
          <p style={{ marginTop: 6 }}>
            <strong>What it does on this offer.</strong> Buying XMR, you are the one who locks funds, so the watcher is yours (Your watcher, under Daemon and connections). If the taker’s XMR lock does not check out while your daemon is down, it freezes the taker’s claim, which gives you up to the window to bring the daemon back and refund. While the daemon is up it decides by itself: a lock that is provably bad is refunded at once rather than frozen (freezing first would give up the hold on the deposit), and a lock that is real but still unconfirmed at the cutoff is frozen by the daemon. There is no freeze button; you never have to press one.
          </p>
          <p style={{ marginTop: 6 }} data-testid="freeze-worst">
            {off ? (
              <>With the window at 0 your swaps on this offer cannot be frozen: a daemon that is down through the refund window can lose the escrow to a false notice.</>
            ) : (
              <>
                The cost is the taker’s, and takers are told before they take: its claim without your ready can wait up to <strong>{fmtDuration(e.worstSecs)}</strong> after its notice (the claim delay of {fmtDuration(e.withoutSecs)} plus the window of {fmtDuration(e.windowSecs)}) instead of {fmtDuration(e.withoutSecs)}, with its XMR locked meanwhile. After a freeze your daemon must set ready or refund {fmtDuration(margin)} before the window ends.
              </>
            )}
          </p>
          <p style={{ marginTop: 6 }}>
            <strong>No deposit to hold.</strong> A refund of yours after a freeze returns the taker’s deposit at once and is counted in your public record as a back-out after a freeze.
          </p>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ a frozen swap

/** Who froze, when, until when, and what the daemon does next. */
export function FrozenPanel({ swap, frozenBy }: { swap: SwapDetail; frozenBy?: FrozenBy | null | undefined }) {
  const d = swap.deadlines;
  const margin = CHAIN_CONSTS[swap.chain].marginSecs;
  const selling = swap.direction === 'A';
  // The chain stores when a swap was frozen, not who called: the daemon infers it, and the console says so.
  const who =
    frozenBy === 'taker_side'
      ? 'Probably the taker’s side: the taker, its session key or the watcher it named.'
      : frozenBy === 'maker'
        ? 'Probably your own daemon, which pauses a swap itself when the taker’s lock is real but still unconfirmed at the cutoff.'
        : frozenBy === 'maker_watcher'
          ? 'Probably your watcher.'
          : 'Not known yet: the daemon has not recorded it.';
  return (
    <div data-testid="frozen-panel">
      <Notice tone="warn" title="This swap is frozen.">
        {selling
          ? 'The taker’s side paused it: your claim without the taker’s ready waits until the frozen-final time. Nothing was revealed and nothing moved.'
          : 'Your side paused it: the taker’s claim without your ready waits until the frozen-final time, which is the time you have to check the lock and act.'}
      </Notice>
      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>Frozen by</dt>
        <dd>
          {who}
          <div className="muted">The chain records when a swap was frozen, not who called. This is the daemon’s inference, not a fact.</div>
        </dd>
        <dt>Watcher key</dt>
        <dd>{swap.extras.watcher ? <code style={{ overflowWrap: 'anywhere' }}>{swap.extras.watcher}</code> : <span className="muted">none named</span>}</dd>
        <dt>Frozen at</dt>
        <dd>
          <span className="mono">{fmtTime(d.t_freeze)}</span> <span className="muted">(<Time at={d.t_freeze} />)</span>
        </dd>
        <dt>Frozen-final time</dt>
        <dd>
          <strong>
            <Countdown to={d.t_ff} chain={swap.chain} urgentBelow={3_600} soonBelow={6 * 3_600} passed="reached" />
          </strong>{' '}
          <span className="muted mono">{fmtTime(d.t_ff)}</span>
          <div className="muted">The freeze window of this swap is {fmtDuration(swap.extras.freeze_window_secs)}.</div>
        </dd>
        <dt>What your daemon does</dt>
        <dd data-testid="frozen-plan">
          {selling ? (
            <>
              Nothing until then. If the taker sets ready first, it claims inside the claim window as usual. If the taker refunds first, it recovers your XMR and the deposit is held for your withhold decision. Otherwise, at the frozen-final time ({fmtTime(d.t_ff)}) it claims, or aborts if this offer is set to abort without ready.
            </>
          ) : (
            <>
              It verifies the taker’s XMR lock, then sets ready (lock good) or refunds (lock bad), no later than {fmtTime(d.t_ff === null ? null : d.t_ff - margin)}: {fmtDuration(margin)} before the frozen-final time. After that the taker may claim.
            </>
          )}
        </dd>
        <dt>Deposit</dt>
        <dd>
          {selling
            ? 'If the taker refunds or you abort from here, the deposit is always withholdable: your withhold policy decides inside the 30-minute hold, and you can override it on the Deposits page.'
            : 'A refund of yours from here returns the taker’s deposit at once; it can never be held.'}
        </dd>
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ the maker's own watcher

export const WATCHER_HONESTY =
  'It sees which swaps you fund, their amounts and timing, the joint address and the taker’s Monero lock transaction. It can do one thing: freeze a swap, which delays the taker’s claim. It cannot move funds and holds no key share. It can be down, and it can freeze a good swap by mistake.';

export function WatcherCard({ watcher }: { watcher: WatcherStatus }) {
  return (
    <div data-testid="watcher-card">
      <dl className="kv">
        <dt>Your watcher</dt>
        <dd>
          {watcher.url === null ? (
            <>
              <Badge>Off</Badge> <span className="muted">none configured</span>
            </>
          ) : watcher.reachable === true ? (
            <Badge tone="ok">Reachable</Badge>
          ) : watcher.reachable === false ? (
            <Badge tone="bad">Not reachable</Badge>
          ) : (
            <Badge tone="info">Not checked yet</Badge>
          )}{' '}
          {watcher.url ? <code style={{ overflowWrap: 'anywhere' }}>{watcher.url}</code> : null}
          {watcher.last_error ? <div className="msg warning">{watcher.last_error}</div> : null}
        </dd>
        {watcher.url !== null ? (
          <>
            <dt>Its Solana key</dt>
            <dd>{watcher.solana ? <code style={{ overflowWrap: 'anywhere' }}>{watcher.solana}</code> : <span className="muted">not reported</span>}</dd>
            <dt>Its Ethereum key</dt>
            <dd>{watcher.ethereum ? <code style={{ overflowWrap: 'anywhere' }}>{watcher.ethereum}</code> : <span className="muted">not reported</span>}</dd>
            <dt>Watching now</dt>
            <dd>{watcher.watching === 1 ? '1 swap' : `${watcher.watching} swaps`}</dd>
          </>
        ) : null}
      </dl>
      <p className="muted" style={{ marginTop: 8 }}>
        For swaps where the taker sells XMR and you lock the funds. {WATCHER_HONESTY} It is the mitigation for your daemon being down during a funded swap, and it only applies to offers with a freeze window. Set it under Configuration, Daemon and connections.
      </p>
    </div>
  );
}

/** The watcher's state for one swap where the maker is the locker (direction B). */
export function SwapWatcherStatus({ swap, status }: { swap: SwapDetailX; status: StatusX | null }) {
  if (swap.direction !== 'B') return null;
  const x = swap.extras;
  const funded = swap.state === 'ACTIVE' || swap.state === 'NOTICED' || swap.state === 'FROZEN';
  const degraded = status ? degradedReasons(status) : [];
  return (
    <div data-testid="swap-watcher">
      <dl className="kv">
        <dt>Your watcher</dt>
        <dd>
          {x.watching_until !== null ? (
            <>
              <Badge tone="ok">Acknowledged</Badge> watching until <span className="mono">{fmtTime(x.watching_until)}</span> (<Countdown to={x.watching_until} chain={swap.chain} passed="over" />)
              <div className="muted">The watcher signed an acknowledgement that it follows this swap until your refund window closes.</div>
              {swap.watcher_ack ? (
                <div className="muted" data-testid="watcher-ack">
                  Signed by <Id value={swap.watcher_ack.watcher} head={8} tail={6} /> <Time at={swap.watcher_ack.at} />; signature <code title={swap.watcher_ack.sig}>{swap.watcher_ack.sig.slice(0, 16)}…</code>
                </div>
              ) : null}
            </>
          ) : x.watcher !== null ? (
            <>
              <Badge tone="warn">Named, not acknowledged</Badge>
              <div className="muted">The swap names a watcher key, but the watcher has not confirmed that it is following it.</div>
            </>
          ) : x.freeze_window_secs === 0 ? (
            <>
              <Badge>Not possible</Badge> <span className="muted">this offer has no freeze window, so the swap cannot be frozen</span>
            </>
          ) : (
            <>
              <Badge tone="warn">None</Badge> <span className="muted">no watcher was named when this swap was funded</span>
            </>
          )}
        </dd>
        {x.watcher ? (
          <>
            <dt>Watcher key</dt>
            <dd>
              <code style={{ overflowWrap: 'anywhere' }}>{x.watcher}</code>
            </dd>
          </>
        ) : null}
      </dl>
      {funded && x.watching_until === null && degraded.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="bad" title="Funded, unwatched, and the daemon is degraded.">
            Your funds are in escrow on this swap, no watcher has acknowledged it, and right now {degraded.join(', ')}. If the daemon cannot check the taker’s XMR lock and refund inside the refund window, a false notice can cost you the escrow. Restore the daemon’s connections now. (“Degraded” is this console’s own reading of the daemon’s status; the daemon does not report it as such.)
          </Notice>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ release and program build

/** Reads `/release.json` from the bundle that served this page. `undefined` while loading, `null` when there is none. */
export function useReleaseRecord(): ReleaseRecord | null | undefined {
  const client = useClient();
  const [record, setRecord] = useState<ReleaseRecord | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    client.releaseRecord().then(
      (r) => live && setRecord(r),
      () => live && setRecord(null),
    );
    return () => {
      live = false;
    };
  }, [client]);
  return record;
}

export function ReleaseCard({ record }: { record: ReleaseRecord | null | undefined }) {
  if (record === undefined) {
    return (
      <p className="muted" role="status">
        Reading the release record…
      </p>
    );
  }
  if (record === null) {
    return (
      <div data-testid="release-card" data-release="none">
        <Notice tone="info" title="No release record.">
          The server this console was loaded from provides no <code>/release.json</code>, so the console cannot say which build it is. A development server and a hand-copied build have none.
        </Notice>
      </div>
    );
  }
  const r = record.release;
  const dev = r?.status === 'development-snapshot';
  return (
    <div data-testid="release-card" data-release={r === null ? 'unrecorded' : dev ? 'development-snapshot' : 'release'}>
      {r === null ? (
        <Notice tone="warn" title="These files match no recorded release.">
          The server reports the hash of what it serves, but no release record has that hash.
        </Notice>
      ) : dev ? (
        <Notice tone="warn" title="Development snapshot.">
          This console was built from a development snapshot, not from a published release. Nothing about it has been published for you to compare with.
        </Notice>
      ) : (
        <Notice tone="ok" title={`Release ${r.version}.`}>The files match a recorded release.</Notice>
      )}
      <dl className="kv" style={{ marginTop: 10 }}>
        {r ? (
          <>
            <dt>Version</dt>
            <dd>
              {r.version} {dev ? <Badge tone="warn">Development snapshot</Badge> : <Badge tone="ok">Release</Badge>}
            </dd>
            <dt>Commit</dt>
            <dd>
              <code style={{ overflowWrap: 'anywhere' }}>{r.commit}</code>
              {r.commit_time ? <span className="muted"> · {r.commit_time}</span> : null}
            </dd>
          </>
        ) : null}
        <dt>UI tree hash</dt>
        <dd>
          <code style={{ overflowWrap: 'anywhere' }}>{record.ui.tree_hash}</code>
          <div className="muted">of the files as served ({record.ui.files} files)</div>
        </dd>
        {r ? (
          <>
            <dt>Expected program id</dt>
            <dd>
              <code style={{ overflowWrap: 'anywhere' }}>{r.program_id}</code>
            </dd>
            <dt>Expected executable hash</dt>
            <dd>
              <code style={{ overflowWrap: 'anywhere' }}>{r.program_executable_hash ?? 'none recorded'}</code>
              <div className="muted">{r.program_hash_source === 'docker' ? 'from the deterministic (Docker) build' : r.program_hash_source === 'local' ? 'from a local build: not a reproducible hash' : ''}</div>
            </dd>
            <dt>Deployed</dt>
            <dd>{r.onchain_deployed ? 'the record says the program is deployed' : 'the record says nothing is deployed yet'}</dd>
          </>
        ) : null}
      </dl>
      <p className="muted" style={{ marginTop: 8 }}>
        This is the server describing itself. It tells you which build the files are, not what to trust: a tampered server could lie here. Check a download with the release’s own verify command.
      </p>
    </div>
  );
}

export function ProgramBuildCard({ build }: { build: ProgramBuildStatus }) {
  const tone = build.matches === true ? 'ok' : build.matches === false ? 'bad' : 'info';
  const title =
    build.matches === true
      ? 'The deployed program matches the published build.'
      : build.matches === false
        ? 'The deployed program does not match the published build.'
        : build.expected_hash === null
          ? 'No published hash yet.'
          : 'The deployed program could not be read.';
  return (
    <div data-testid="program-build" data-matches={String(build.matches)}>
      <Notice tone={tone} title={title}>
        {build.matches === false
          ? 'What is on the chain is not what this daemon was built to run against. Do not rely on it: pause quoting and find out why before anything else.'
          : build.matches === null && build.expected_hash === null
            ? 'No program hash has been published, so there is nothing to compare the deployed program with. That is the case until a release publishes one.'
            : build.matches === null
              ? 'Treat it as unverified until the daemon can read it.'
              : 'The hash of the deployed program equals the one this daemon expects.'}
      </Notice>
      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>Program id</dt>
        <dd>
          <code style={{ overflowWrap: 'anywhere' }}>{build.program_id}</code>
        </dd>
        <dt>Expected hash</dt>
        <dd>{build.expected_hash ? <code style={{ overflowWrap: 'anywhere' }}>{build.expected_hash}</code> : <span className="muted">none</span>}</dd>
        <dt>On-chain hash</dt>
        <dd>{build.on_chain_hash ? <code style={{ overflowWrap: 'anywhere' }}>{build.on_chain_hash}</code> : <span className="muted">unreadable</span>}</dd>
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ what one swap costs the operator

/** The operator's transactions of one ordinary swap, in the daemon's own figures (its `swap_cost`). */
export function SwapCostTable({ cost }: { cost: SwapCost }) {
  const sol = (v: string | number): string => `${(Number(v) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`;
  const eth = (v: string | null): string => (v === null ? 'no gas cap set' : `${(Number(BigInt(v) / 1_000_000_000n) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 6 })} ETH`);
  const rows: [string, string, string][] = [];
  for (const asset of ['sol', 'usdc_sol'] as const) {
    const c = cost.solana[asset];
    const name = asset === 'sol' ? 'SOL' : 'USDC-SOL';
    rows.push([`${name}, sell XMR`, `${c.sell_xmr.compute_units.toLocaleString('en-US')} compute units`, sol(c.sell_xmr.lamports)]);
    rows.push([`${name}, sell XMR with an approval window`, `${c.sell_xmr_window.compute_units.toLocaleString('en-US')} compute units`, sol(c.sell_xmr_window.lamports)]);
    rows.push([`${name}, buy XMR`, `${c.buy_xmr.compute_units.toLocaleString('en-US')} compute units`, sol(c.buy_xmr.lamports)]);
  }
  rows.push(['Ethereum, sell XMR', `${cost.ethereum.sell_xmr_gas.toLocaleString('en-US')} gas`, eth(cost.ethereum.sell_xmr_wei)]);
  rows.push(['Ethereum, buy XMR', `${cost.ethereum.buy_xmr_gas.toLocaleString('en-US')} gas`, eth(cost.ethereum.buy_xmr_wei)]);
  return (
    <div data-testid="swap-cost">
      <table className="tbl" aria-label="Cost of one swap to you">
        <thead>
          <tr>
            <th scope="col">One swap</th>
            <th scope="col" className="num">
              Work
            </th>
            <th scope="col" className="num">
              Fees, at most
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, work, fee]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td className="num">{work}</td>
              <td className="num">{fee}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ marginTop: 6 }}>
        Your daemon’s own transactions for one ordinary swap, at your priority fee{cost.ethereum.max_fee_gwei === null ? '' : ` and your gas cap of ${cost.ethereum.max_fee_gwei} gwei`}. A freeze on Ethereum costs {cost.ethereum.freeze_gas.toLocaleString('en-US')} gas and delivering a parked payout {cost.ethereum.push_owed_gas.toLocaleString('en-US')}. The taker pays for its own opening transaction.
      </p>
    </div>
  );
}
