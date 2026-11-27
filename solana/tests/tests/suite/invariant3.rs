//! Invariant 3 (SPEC 11.1): admin and maker switches gate only new exposure. No cap, pause,
//! epoch bump, `split_mode` or freeze of the configuration may block, delay or alter any exit.
//!
//! Every exit of SPEC 3.4 to 3.6 and 11.6 is written here as a path: an open followed by the
//! calls that take the swap to its end, including the deposit sub-machine, parked payouts
//! (withdrawn by their owner and delivered by a stranger) and `close_swap`. Each path is run
//! once undisturbed, and then once for **every position in it**: after that step, with the swap
//! in whatever state it has reached, the admin sets every cap to zero with the switch on, flips
//! `split_mode`, the owner and the operator set both pause bits, both epochs are bumped, and the
//! configuration is frozen for good. The rest of the path must then go exactly as it did
//! undisturbed: every call succeeds at the same instant, the record is the same after every
//! step, and at the end every party has received the same.
//!
//! The one thing a switch may change is which account the treasury's half of a split is *tried*
//! at: with the mode flipped under a split in flight the half is parked (it does not fail, and
//! nobody else gets it) and is delivered afterwards.
//!
//! The same walk checks the open-value accounting of SPEC 11.1 at every step: a second swap
//! stays open in the same world throughout, and the asset's open value must be exactly that
//! swap's counted value plus this one's while it is open: subtracted once, at the transition
//! that leaves the open states, and never again at a release, a split, a withdrawal or a close.
use crate::common::*;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

const AMOUNT: u64 = 1_500_000_000;
const D: u64 = 15_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum At {
    /// No waiting.
    Now,
    /// Seconds after the previous step.
    Plus(i64),
    Pend,
    Note,
    Cut,
    Co,
    Cd,
    Ff,
    Final,
    Exp,
    Hold,
    Split,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Who {
    Taker,
    Session,
    Operator,
    Owner,
    Watcher,
    /// The payout address named at take.
    Dest,
    Stranger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Party {
    Taker,
    /// The maker's destination: its payout wallet (a claim in A).
    Maker,
    /// The payout address named at take.
    Dest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Approve,
    Fund,
    Reject,
    Cancel(Who),
    ExpirePending,
    Notice,
    Ready,
    Freeze(Who),
    Abort,
    RefundUnnoticed,
    ExpireUnnoticed,
    Refund,
    Claim(Who),
    Release(Who),
    Withhold,
    Split,
    /// `withdraw_owed(2)` by a stranger, if the treasury's half of a split was parked.
    DeliverTreasury,
    PublishEvidence,
    /// `withdraw_owed(who)` signed by its owner.
    Withdraw(u8, Who),
    /// `withdraw_owed(0)` by a stranger, pinned to the payout address.
    Deliver,
    /// Make a destination unable (or able again) to receive: a frozen token account, or for SOL
    /// an executable account at that address.
    Block(Party),
    Unblock(Party),
    /// `close_swap` by whoever is entitled to it (skipped if the row closed the account).
    Close,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Open {
    /// Direction A, auto: ACTIVE at lock.
    A,
    /// Direction A, window mode: PENDING at lock.
    AWindow,
    /// Direction A, auto, with a watcher named.
    AWatched,
    /// Direction B: PENDING at take (window mode: rejectable).
    B,
    BWindow,
    /// Direction B with a payout address other than the taker's.
    BPayout,
    /// Direction B; the maker names a watcher at fund.
    BWatched,
}
impl Open {
    fn direction(self) -> u8 {
        if matches!(self, Open::A | Open::AWindow | Open::AWatched) {
            DIR_A
        } else {
            DIR_B
        }
    }
}

type Path = (&'static str, Open, Vec<(At, Step)>);

fn paths() -> Vec<Path> {
    use At::*;
    use Step::*;
    let n = |s: Step| (Now, s);
    vec![
        // ---- direction A: pending exits
        ("A3 reject", Open::AWindow, vec![n(Reject)]),
        ("A4 cancel", Open::AWindow, vec![n(Cancel(Who::Session))]),
        ("A5 expire", Open::AWindow, vec![(Pend, ExpirePending)]),
        ("A2 approve to the end", Open::AWindow, vec![(Plus(12), Approve), (Plus(90), Notice), (Plus(600), Ready), (Plus(60), Claim(Who::Operator)), n(Close)]),
        // ---- direction A: no notice
        ("A8 refund_unnoticed", Open::A, vec![(Note, RefundUnnoticed)]),
        ("A7a abort before the notice", Open::A, vec![n(Abort)]),
        ("A10a cancel after approval, released early", Open::A, vec![n(Refund), n(Release(Who::Operator)), n(Close)]),
        ("A10a, withheld without evidence, split", Open::A, vec![n(Refund), n(Withhold), (At::Split, Step::Split), n(DeliverTreasury), n(Close)]),
        ("A10g keyed refund after T_note", Open::A, vec![(Note, Refund), n(Close)]),
        // ---- direction A: after the notice
        ("A7b abort early, A10d", Open::A, vec![(Plus(90), Notice), n(Abort), n(Refund), n(Close)]),
        ("A7c abort late, A10c, release at T_hold", Open::A, vec![(Plus(90), Notice), (Co, Abort), (Plus(60), Refund), (Hold, Release(Who::Stranger)), n(Close)]),
        ("A7d abort in READY, A10d", Open::A, vec![(Plus(90), Notice), (Plus(600), Ready), n(Abort), n(Refund), n(Close)]),
        ("A10b, withheld with evidence, split", Open::A, vec![(Plus(90), Notice), n(Refund), n(Withhold), (At::Split, Step::Split), n(DeliverTreasury), n(Close)]),
        ("A10b, withheld, released on request", Open::A, vec![(Plus(90), Notice), n(Refund), n(Withhold), (Plus(86_400), Release(Who::Operator)), n(Close)]),
        ("A10e missed claim", Open::A, vec![(Plus(90), Notice), (Plus(600), Ready), (Cd, Refund), n(Close)]),
        ("A10f expiry", Open::A, vec![(Plus(90), Notice), (Exp, Refund), n(Close)]),
        ("A11a claim", Open::A, vec![(Plus(90), Notice), n(PublishEvidence), (Plus(600), Ready), n(Claim(Who::Operator)), n(Close)]),
        ("A11b claim without ready", Open::A, vec![(Plus(90), Notice), (Co, Claim(Who::Operator)), n(Close)]),
        ("A11c claim after final, from an abort", Open::A, vec![(Plus(90), Notice), (Co, Abort), (Final, Claim(Who::Operator)), n(Close)]),
        ("A11a parked for the maker, withdrawn", Open::A, vec![(Plus(90), Notice), (Plus(600), Ready), n(Block(Party::Maker)), n(Claim(Who::Operator)), n(Unblock(Party::Maker)), n(Withdraw(1, Who::Owner)), n(Close)]),
        ("A10b parked for the taker, withdrawn, released", Open::A, vec![(Plus(90), Notice), n(Block(Party::Taker)), n(Refund), n(Unblock(Party::Taker)), n(Withdraw(0, Who::Taker)), (Hold, Release(Who::Stranger)), n(Close)]),
        ("A4 cancel parked, withdrawn", Open::AWindow, vec![n(Block(Party::Taker)), n(Cancel(Who::Session)), n(Unblock(Party::Taker)), n(Withdraw(0, Who::Taker)), n(Close)]),
        // ---- direction A: freeze (SPEC 11.6)
        ("Z1 by the watcher, Z2 ready, claim", Open::AWatched, vec![(Plus(90), Notice), n(Freeze(Who::Watcher)), (Plus(600), Ready), n(Claim(Who::Operator)), n(Close)]),
        ("Z1 by the locker, Z3 refund, withheld, released", Open::AWatched, vec![(Plus(90), Notice), n(Freeze(Who::Session)), n(Refund), n(Withhold), n(Release(Who::Operator)), n(Close)]),
        ("Z4 claim at T_ff", Open::AWatched, vec![(Plus(90), Notice), n(Freeze(Who::Watcher)), (Ff, Claim(Who::Operator)), n(Close)]),
        ("Z5 abort, refund, release", Open::AWatched, vec![(Plus(90), Notice), n(Freeze(Who::Watcher)), n(Abort), n(Refund), (Hold, Release(Who::Stranger)), n(Close)]),
        ("Z6 claim at the final deadline", Open::AWatched, vec![(Plus(90), Notice), n(Freeze(Who::Watcher)), (Final, Claim(Who::Operator)), n(Close)]),
        ("Z6 refund at expiry", Open::AWatched, vec![(Plus(90), Notice), n(Freeze(Who::Watcher)), (Exp, Refund), n(Close)]),
        // ---- direction B: pending exits
        ("B2 cancel", Open::B, vec![n(Cancel(Who::Taker))]),
        ("B3 reject", Open::BWindow, vec![n(Reject)]),
        ("B4 lapse", Open::B, vec![(Pend, ExpirePending)]),
        // ---- direction B: the maker's refunds
        ("B9a backout before the notice", Open::B, vec![(Plus(12), Fund), n(Refund), n(Close)]),
        ("B9b no notice, released at T_hold", Open::B, vec![(Plus(12), Fund), (Note, Refund), (Hold, Release(Who::Stranger)), n(Close)]),
        ("B9c backout after the notice", Open::B, vec![(Plus(12), Fund), (Plus(90), Notice), n(Refund), n(Close)]),
        ("B9h late notice, withheld, split", Open::B, vec![(Plus(12), Fund), (Note, Notice), (Plus(60), Refund), n(Withhold), (At::Split, Step::Split), n(DeliverTreasury), n(Close)]),
        ("B9d unconfirmed, released by the operator", Open::B, vec![(Plus(12), Fund), (Plus(90), Notice), (Cut, Refund), n(Release(Who::Operator)), n(Close)]),
        ("B9e the taker missed its claim", Open::B, vec![(Plus(12), Fund), (Plus(90), Notice), (Plus(600), Ready), (Cd, Refund), (Hold, Release(Who::Stranger)), n(Close)]),
        ("B8 abort, B9f, release", Open::B, vec![(Plus(12), Fund), (Plus(90), Notice), n(Abort), n(Refund), (Hold, Release(Who::Stranger)), n(Close)]),
        ("B9g expiry", Open::B, vec![(Plus(12), Fund), (Plus(90), Notice), (Exp, Refund), n(Close)]),
        ("B11 expire_unnoticed, the maker pulls its escrow", Open::B, vec![(Plus(12), Fund), (Exp, ExpireUnnoticed), n(Withdraw(1, Who::Owner)), n(Close)]),
        // ---- direction B: the taker's claims
        ("B10a claim", Open::B, vec![(Plus(12), Fund), (Plus(90), Notice), n(PublishEvidence), (Plus(600), Ready), n(Claim(Who::Session)), n(Close)]),
        ("B10b claim without ready", Open::B, vec![(Plus(12), Fund), (Plus(90), Notice), (Co, Claim(Who::Taker)), n(Close)]),
        ("B10c claim after final", Open::B, vec![(Plus(12), Fund), (Plus(90), Notice), (Final, Claim(Who::Session)), n(Close)]),
        ("B10a to a payout address", Open::BPayout, vec![(Plus(12), Fund), (Plus(90), Notice), (Plus(600), Ready), n(Claim(Who::Session)), n(Close)]),
        ("B10a parked for the payout address, delivered by a stranger", Open::BPayout, vec![(Plus(12), Fund), (Plus(90), Notice), (Plus(600), Ready), n(Block(Party::Dest)), n(Claim(Who::Session)), n(Unblock(Party::Dest)), n(Deliver), n(Close)]),
        ("B10b parked for the payout address, pulled by it", Open::BPayout, vec![(Plus(12), Fund), (Plus(90), Notice), n(Block(Party::Dest)), (Co, Claim(Who::Taker)), n(Unblock(Party::Dest)), n(Withdraw(0, Who::Dest)), n(Close)]),
        ("B10a parked for the taker, withdrawn", Open::B, vec![(Plus(12), Fund), (Plus(90), Notice), (Plus(600), Ready), n(Block(Party::Taker)), n(Claim(Who::Session)), n(Unblock(Party::Taker)), n(Withdraw(0, Who::Taker)), n(Close)]),
        // ---- direction B: freeze
        ("Z1 by the maker's watcher, Z3 refund returns the deposit at once", Open::BWatched, vec![(Plus(12), Fund), (Plus(90), Notice), n(Freeze(Who::Watcher)), n(Refund), n(Close)]),
        ("Z1 by the operator, Z2 ready, claim", Open::BWatched, vec![(Plus(12), Fund), (Plus(90), Notice), n(Freeze(Who::Operator)), (Plus(600), Ready), n(Claim(Who::Session)), n(Close)]),
        ("Z4 the taker's claim at T_ff", Open::BWatched, vec![(Plus(12), Fund), (Plus(90), Notice), n(Freeze(Who::Watcher)), (Ff, Claim(Who::Taker)), n(Close)]),
        ("Z5 the taker aborts, refund, release", Open::BWatched, vec![(Plus(12), Fund), (Plus(90), Notice), n(Freeze(Who::Watcher)), n(Abort), n(Refund), (Hold, Release(Who::Stranger)), n(Close)]),
    ]
}

/// One swap in one world, with the keys the steps need.
struct Run {
    w: World,
    m: MakerFx,
    fx: SwapFx,
    watcher: Keypair,
    dest: Keypair,
    asset: u8,
    /// The counted value of the second swap that stays open throughout.
    background: u64,
    /// This swap's counted value.
    counted: u64,
    /// The `split_mode` this world's transactions are built for (the one at the open).
    built_for_mode: u8,
}

/// The record after a step, as far as two runs must agree on it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Mark {
    step: String,
    at: i64,
    /// 0 once the account is closed.
    state: u8,
    outcome: u8,
    flags: u8,
    deposit_state: u8,
    owed_taker: u64,
    owed_maker: u64,
    open_value: u64,
    open_pending: u16,
}

/// Asset units each party holds (SOL: lamports of the wallet, the taker's with its session key).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Holdings {
    taker: i128,
    maker_payout: i128,
    operator: i128,
    dest: i128,
    /// The treasury, plus whatever was burned (SOL: the incinerator; USDC: the supply that left).
    treasury_or_burned: i128,
    watcher: i128,
}

fn holdings(r: &Run) -> Holdings {
    let w = &r.w;
    if r.asset == ASSET_USDC {
        let supply = u64::from_le_bytes(w.data(&w.mint)[36..44].try_into().unwrap()) as i128;
        Holdings {
            taker: w.tokens(&w.ata(&r.fx.taker.pubkey())) as i128,
            maker_payout: w.tokens(&w.ata(&r.m.payout.pubkey())) as i128,
            operator: w.tokens(&w.ata(&r.m.operator.pubkey())) as i128,
            dest: w.tokens(&w.ata(&r.dest.pubkey())) as i128,
            treasury_or_burned: w.tokens(&w.treasury_vault) as i128 - supply,
            watcher: w.tokens(&w.ata(&r.watcher.pubkey())) as i128,
        }
    } else {
        Holdings {
            taker: (w.lamports(&r.fx.taker.pubkey()) + w.lamports(&r.fx.session.pubkey())) as i128,
            maker_payout: w.lamports(&r.m.payout.pubkey()) as i128,
            operator: w.lamports(&r.m.operator.pubkey()) as i128,
            dest: w.lamports(&r.dest.pubkey()) as i128,
            treasury_or_burned: (w.lamports(&w.treasury) + w.lamports(&INCINERATOR)) as i128,
            watcher: w.lamports(&r.watcher.pubkey()) as i128,
        }
    }
}

fn open(kind: Open, asset: u8) -> Run {
    open_in(kind, asset, 0)
}

/// As [`open`], in a deployment whose `split_mode` is `mode`.
fn open_in(kind: Open, asset: u8, mode: u8) -> Run {
    let mut w = World::with(sha256(&[b"test cluster"]), mode);
    let mut m = w.register_maker();
    let direction = kind.direction();
    let watched = matches!(kind, Open::AWatched | Open::BWatched);
    let terms = Terms {
        mode: if matches!(kind, Open::AWindow | Open::BWindow) { 1 } else { 0 },
        w_z: if watched { 86_400 } else { 0 },
        ..Terms::default()
    };
    // A second swap of another taker stays open for the whole walk: the open value this walk
    // checks is never just "zero or one swap".
    let other = Terms { mode: 0, ..terms.clone() };
    let bg = w.swap_with(&mut m, asset, DIR_B, &other, Stage::Opened);
    let s = w.swap(&bg.pda).unwrap();
    let background = s.amount + s.deposit;

    let offer = w.live_offer(&mut m, asset, direction, &terms, PRICE);
    let watcher = w.fund(SOL);
    let dest = w.fund(SOL);
    w.make_ata(&dest.pubkey());
    let (mut fx, mut raw) = w.prepare_open(&m, asset, direction, XMR, Source::Offer(offer));
    if kind == Open::AWatched {
        raw.watcher = Some(watcher.pubkey());
    }
    if kind == Open::BPayout {
        raw.payout = dest.pubkey();
        fx.payout = dest.pubkey();
    }
    ok(w.send_open(&fx, &raw));
    let s = w.swap(&fx.pda).unwrap();
    let counted = if direction == DIR_A { s.amount } else { s.amount + s.deposit };
    assert_eq!((s.amount, s.deposit, s.flags & FLAG_COUNTED), (AMOUNT, D, FLAG_COUNTED));
    assert_eq!(w.open_value(asset), background + counted, "added once, at the open");
    let built_for_mode = w.data(&w.config)[136];
    Run { w, m, fx, watcher, dest, asset, background, counted, built_for_mode }
}

/// Everything an admin or a maker can switch, switched against the swap in flight.
fn hostile(r: &mut Run) {
    let w = &mut r.w;
    let (owner, op, admin) = (r.m.owner.insecure_clone(), r.m.operator.insecure_clone(), w.admin.insecure_clone());
    let before = (w.lamports(&owner.pubkey()), w.lamports(&op.pubkey()));
    // Every cap zero, the switch on.
    ok(w.set_caps(true, [0; 2], [0; 2]));
    // The other split mode.
    let mode = 1 - w.data(&w.config)[136];
    let ix = w.admin_ix(&admin.pubkey(), Enc::ix("set_split_mode").u8(mode).0);
    ok(w.send(&[ix], &[&admin]));
    // Both pause bits.
    for signer in [&owner, &op] {
        let ix = w.maker_ix(&signer.pubkey(), &r.m.pda, Enc::ix("set_paused").bool(true).0);
        ok(w.send(&[ix], &[signer]));
    }
    assert_eq!(w.maker(&r.m.pda).paused, 0b11);
    // Both epochs.
    ok(w.bump_epochs(&r.m, true, true));
    // And the configuration frozen as it is: nobody can ever lift any of it.
    let ix = w.admin_ix(&admin.pubkey(), Enc::ix("freeze_config").0);
    ok(w.send(&[ix], &[&admin]));
    assert_err(w.set_caps(false, [u64::MAX; 2], [u64::MAX; 2]), "ConfigFrozen");
    // The maker's own transactions cost it fees the undisturbed run does not have: give them back,
    // so that the two runs' balances can be compared to the lamport.
    for (key, was) in [(owner.pubkey(), before.0), (op.pubkey(), before.1)] {
        let spent = was - w.lamports(&key);
        if spent > 0 {
            w.svm.airdrop(&key, spent).unwrap();
        }
    }
    // The switches do what they are for: nothing new opens.
    let offer = w.offer_pda(&r.m.pda, r.asset, DIR_B);
    ok(w.refresh(&r.m, &[(r.asset, DIR_B, true, [PRICE, 0, 0], 1_000 * XMR)]));
    w.svm.airdrop(&op.pubkey(), FEE).unwrap();
    // (A taker with an empty token account: minting to it would move the supply this walk
    // measures burns by.)
    let newcomer = w.fund(10 * SOL);
    w.make_ata(&newcomer.pubkey());
    let (fx, raw) = w.prepare_open_for(&r.m, newcomer, r.asset, DIR_B, XMR, Source::Offer(offer), rand16());
    assert_err(w.send_open(&fx, &raw), "Paused");
    assert_eq!(w.caps(r.asset), (true, 0, 0, w.open_value(r.asset)));
}

fn key_of(r: &Run, who: Who) -> Keypair {
    match who {
        Who::Taker => r.fx.taker.insecure_clone(),
        Who::Session => r.fx.session.insecure_clone(),
        Who::Operator => r.m.operator.insecure_clone(),
        Who::Owner => r.m.owner.insecure_clone(),
        Who::Watcher => r.watcher.insecure_clone(),
        Who::Dest => r.dest.insecure_clone(),
        Who::Stranger => r.w.stranger.insecure_clone(),
    }
}

fn block(r: &mut Run, party: Party, blocked: bool) {
    let wallet: Pubkey = match party {
        Party::Taker => r.fx.taker.pubkey(),
        Party::Maker => r.m.payout.pubkey(),
        Party::Dest => r.dest.pubkey(),
    };
    if r.asset == ASSET_USDC {
        let ata = r.w.ata(&wallet);
        r.w.set_frozen(&ata, blocked);
    } else {
        r.w.set_can_receive_sol(&wallet, !blocked);
    }
}

/// Run one step. A failure is returned with its logs: in a disturbed run it is the finding.
fn step(r: &mut Run, at: At, step: Step) -> Result<(), String> {
    // The time: the same instant in every run of the path.
    if let Some(s) = r.w.swap(&r.fx.pda) {
        let target = match at {
            At::Now => None,
            At::Plus(d) => Some(r.w.now() + d),
            At::Pend => Some(s.t_pending_deadline),
            At::Note => Some(s.t_note_deadline),
            At::Cut => Some(s.t_cut),
            At::Co => Some(s.t_claim_open),
            At::Cd => Some(s.t_claim_deadline),
            At::Ff => Some(s.t_ff()),
            At::Final => Some(s.t_final),
            At::Exp => Some(s.t_exp()),
            At::Hold => Some(s.t_refund + HOLD_SECS),
            At::Split => Some(s.t_refund + SPLIT_SECS),
        };
        if let Some(t) = target {
            assert!(t >= r.w.now(), "{step:?}: the path goes back in time");
            r.w.set_time(t);
        }
    }
    let is_a = r.fx.direction == DIR_A;
    let (op, taker, session) = (key_of(r, Who::Operator), key_of(r, Who::Taker), key_of(r, Who::Session));
    let (locker, claimer) = if is_a { (session.insecure_clone(), op.insecure_clone()) } else { (op.insecure_clone(), session.insecure_clone()) };
    // A session key swept to zero by an earlier step (a refund, a claim, a cancel) cannot pay a
    // fee; anyone can send it lamports again.
    if r.w.lamports(&session.pubkey()) == 0 {
        r.w.svm.airdrop(&session.pubkey(), r.w.rent(0) + 100_000).unwrap();
    }
    let send = |r: &mut Run, call: Call, signer: &Keypair| -> Result<(), String> {
        let ix = r.w.call_ix(&r.m, &r.fx, &call, &signer.pubkey());
        send_ix(r, ix, signer, call.name())
    };
    match step {
        Step::Approve => r.w.approve(&mut r.m, &r.fx).map(|_| ()).map_err(|e| failure("approve", &e)),
        Step::Fund => {
            // The maker's watcher is named at fund when the offer has a freeze window.
            let named = (r.w.swap(&r.fx.pda).unwrap().w_z > 0).then(|| r.watcher.pubkey());
            r.w.fund_swap_with(&mut r.m, &r.fx, named).map(|_| ()).map_err(|e| failure("fund", &e))
        }
        Step::Reject => {
            let open = r.w.swap(&r.fx.pda).unwrap().open_hash(&r.fx.pda);
            send(r, Call::Reject { open, reason: 0 }, &op)
        }
        Step::Cancel(who) => send(r, Call::CancelPending, &key_of(r, who)),
        Step::ExpirePending => send(r, Call::ExpirePending, &key_of(r, Who::Stranger)),
        Step::Notice => r.w.notice(&r.m, &mut r.fx).map(|_| ()).map_err(|e| failure("post_notice", &e)),
        Step::Ready => send(r, Call::SetReady, &locker),
        Step::Freeze(who) => send(r, Call::Freeze, &key_of(r, who)),
        Step::Abort => send(r, Call::Abort, &claimer),
        Step::RefundUnnoticed => send(r, Call::RefundUnnoticed, &key_of(r, Who::Stranger)),
        Step::ExpireUnnoticed => send(r, Call::ExpireUnnoticed, &key_of(r, Who::Stranger)),
        Step::Refund => {
            let secret = r.w.locker_secret(&r.m, &r.fx);
            send(r, Call::Refund(secret), &locker)
        }
        Step::Claim(who) => {
            let secret = r.w.claimer_secret(&r.m, &r.fx);
            send(r, Call::Claim(secret), &key_of(r, who))
        }
        Step::Release(who) => send(r, Call::ReleaseDeposit, &key_of(r, who)),
        Step::Withhold => send(r, Call::Withhold(r.fx.notice), &op),
        Step::Split => {
            // Built for the split mode in force when the swap was opened: an admin's flip since
            // then must not fail it.
            let stranger = key_of(r, Who::Stranger);
            let mut ix = r.w.call_ix(&r.m, &r.fx, &Call::SplitDeposit, &stranger.pubkey());
            if r.built_for_mode == 1 {
                if r.asset == ASSET_USDC {
                    ix.accounts[S_TREASURY_VAULT] = opt(None, true);
                } else {
                    ix.accounts[S_TREASURY].pubkey = INCINERATOR;
                }
            }
            send_ix(r, ix, &stranger, "split_deposit")
        }
        Step::DeliverTreasury => match r.w.swap(&r.fx.pda) {
            Some(s) if s.owed_treasury > 0 => send(r, Call::WithdrawOwed(2), &key_of(r, Who::Stranger)),
            _ => Ok(()),
        },
        Step::PublishEvidence => {
            let (txid, view) = r.fx.notice.unwrap();
            send(r, Call::PublishEvidence(txid, view), &claimer)
        }
        Step::Withdraw(who, signer) => send(r, Call::WithdrawOwed(who), &key_of(r, signer)),
        Step::Deliver => {
            // Anyone, with the destination pinned to the payout address (the default accounts).
            assert_eq!(r.fx.payout, r.dest.pubkey());
            send(r, Call::WithdrawOwed(0), &key_of(r, Who::Stranger))
        }
        Step::Block(party) => {
            block(r, party, true);
            Ok(())
        }
        Step::Unblock(party) => {
            block(r, party, false);
            Ok(())
        }
        Step::Close => {
            let Some(s) = r.w.swap(&r.fx.pda) else { return Ok(()) };
            // No secret in it: anyone. Otherwise the party that has to read the secret: the
            // claimer after a refund, the locker after a claim.
            let signer = if s.flags & 0b100 == 0 {
                key_of(r, Who::Stranger)
            } else if s.flags & 0b1000 != 0 {
                if is_a { op.insecure_clone() } else { taker.insecure_clone() }
            } else if is_a {
                taker.insecure_clone()
            } else {
                op.insecure_clone()
            };
            send(r, Call::CloseSwap, &signer)
        }
    }
}

fn failure(name: &str, e: &litesvm::types::FailedTransactionMetadata) -> String {
    format!("{name} failed: {:?}\n{}", e.err, e.meta.pretty_logs())
}

fn send_ix(r: &mut Run, ix: solana_instruction::Instruction, signer: &Keypair, name: &str) -> Result<(), String> {
    r.w.send(&[ix], &[signer]).map(|_| ()).map_err(|e| failure(name, &e))
}

fn mark(r: &Run, step: Step) -> Mark {
    let s = r.w.swap(&r.fx.pda);
    let get = |f: fn(&SwapAcc) -> u64| s.as_ref().map(f).unwrap_or(0);
    Mark {
        step: format!("{step:?}"),
        at: r.w.now(),
        state: s.as_ref().map(|s| s.state).unwrap_or(0),
        outcome: get(|s| s.outcome as u64) as u8,
        flags: get(|s| s.flags as u64) as u8,
        deposit_state: get(|s| s.deposit_state as u64) as u8,
        owed_taker: get(|s| s.owed_taker),
        owed_maker: get(|s| s.owed_maker),
        open_value: r.w.open_value(r.asset),
        open_pending: r.w.maker(&r.m.pda).open_pending,
    }
}

/// Run a path; `disturb_after`: apply every hostile switch right after that step (`Some(0)` is
/// right after the open). Returns the record after every step and what everybody received.
fn walk(path: &Path, asset: u8, disturb_after: Option<usize>) -> Result<(Vec<Mark>, Holdings), String> {
    let (_, kind, steps) = path;
    let mut r = open(*kind, asset);
    let start = holdings(&r);
    if disturb_after == Some(0) {
        hostile(&mut r);
    }
    let mut marks = vec![];
    for (i, (at, s)) in steps.iter().enumerate() {
        step(&mut r, *at, *s).map_err(|e| format!("step {} {s:?}: {e}", i + 1))?;
        let m = mark(&r, *s);
        // SPEC 11.1, at every step: the open value is exactly the swaps that are open. One
        // subtraction when this swap leaves the open states; none at a release, a split, a
        // withdrawal or a close; never below the other swap's value.
        let open_states = [PENDING, ACTIVE, NOTICED, READY, FROZEN, ABORTED_FREE, ABORTED_HOLD];
        let is_open = open_states.contains(&m.state);
        let want = r.background + if is_open { r.counted } else { 0 };
        if m.open_value != want {
            return Err(format!("step {} {s:?}: open value {}, want {want} (state {})", i + 1, m.open_value, m.state));
        }
        if m.state != 0 && (m.flags & FLAG_COUNTED != 0) != is_open {
            return Err(format!("step {} {s:?}: the counted flag is {} in state {}", i + 1, m.flags & FLAG_COUNTED, m.state));
        }
        marks.push(m);
        if disturb_after == Some(i + 1) && i + 1 < steps.len() {
            hostile(&mut r);
        }
    }
    // Nothing is left parked, and the treasury's half was not lost on the way.
    if let Some(s) = r.w.swap(&r.fx.pda) {
        if (s.owed_taker, s.owed_maker, s.owed_treasury) != (0, 0, 0) {
            return Err(format!("the path ends with parked payouts: {s:?}"));
        }
    }
    let end = holdings(&r);
    let moved = Holdings {
        taker: end.taker - start.taker,
        maker_payout: end.maker_payout - start.maker_payout,
        operator: end.operator - start.operator,
        dest: end.dest - start.dest,
        treasury_or_burned: end.treasury_or_burned - start.treasury_or_burned,
        watcher: end.watcher - start.watcher,
    };
    Ok((marks, moved))
}

fn walk_all(asset: u8) {
    let paths = paths();
    let (mut walks, mut exits) = (0, 0);
    let mut failures = vec![];
    for path in &paths {
        let (name, _, steps) = path;
        // Undisturbed: the path is what it claims to be.
        let (marks, moved) = walk(path, asset, None).unwrap_or_else(|e| panic!("{name} (undisturbed): {e}"));
        let last = marks.last().unwrap();
        assert!(last.state == 0 || last.state == DONE, "{name}: the path does not reach the end ({})", last.state);
        assert_eq!(moved.watcher, if asset == ASSET_SOL { -(watcher_fees(steps) as i128) } else { 0 }, "{name}: a watcher is never paid");
        exits += steps.len();
        // Disturbed at every position, from right after the open.
        for k in 0..steps.len() {
            walks += 1;
            match walk(path, asset, Some(k)) {
                Err(e) => failures.push(format!("{name}, switches thrown after step {k}: {e}")),
                Ok((disturbed, disturbed_moved)) => {
                    if disturbed != marks {
                        let first = disturbed.iter().zip(marks.iter()).find(|(a, b)| a != b).unwrap();
                        failures.push(format!("{name}, switches thrown after step {k}: the record differs: {:?} vs undisturbed {:?}", first.0, first.1));
                    } else if disturbed_moved != moved {
                        failures.push(format!("{name}, switches thrown after step {k}: funds differ: {disturbed_moved:?} vs undisturbed {moved:?}"));
                    }
                }
            }
        }
    }
    println!("invariant 3, asset {asset}: {} paths, {exits} steps, {walks} disturbed walks, {} failures", paths.len(), failures.len());
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

/// Fees the watcher key paid in a path (SOL holdings are lamports).
fn watcher_fees(steps: &[(At, Step)]) -> u64 {
    steps.iter().filter(|(_, s)| matches!(s, Step::Freeze(Who::Watcher))).count() as u64 * FEE
}

#[test]
fn no_switch_blocks_delays_or_alters_any_exit_sol() {
    walk_all(ASSET_SOL);
}

#[test]
fn no_switch_blocks_delays_or_alters_any_exit_usdc() {
    walk_all(ASSET_USDC);
}

/// The paths above are every exit: each call of the invariant's list is in at least one, from
/// every state it is allowed in.
#[test]
fn the_walk_covers_every_exit_call() {
    let paths = paths();
    let has = |pred: &dyn Fn(&Step) -> bool| paths.iter().any(|(_, _, steps)| steps.iter().any(|(_, s)| pred(s)));
    for (name, pred) in [
        ("approve", (&|s: &Step| *s == Step::Approve) as &dyn Fn(&Step) -> bool),
        ("fund", &|s| *s == Step::Fund),
        ("reject", &|s| *s == Step::Reject),
        ("cancel_pending", &|s| matches!(s, Step::Cancel(_))),
        ("expire_pending", &|s| *s == Step::ExpirePending),
        ("post_notice", &|s| *s == Step::Notice),
        ("set_ready", &|s| *s == Step::Ready),
        ("freeze", &|s| matches!(s, Step::Freeze(_))),
        ("abort", &|s| *s == Step::Abort),
        ("refund_unnoticed", &|s| *s == Step::RefundUnnoticed),
        ("expire_unnoticed", &|s| *s == Step::ExpireUnnoticed),
        ("refund", &|s| *s == Step::Refund),
        ("claim", &|s| matches!(s, Step::Claim(_))),
        ("release_deposit", &|s| matches!(s, Step::Release(_))),
        ("withhold", &|s| *s == Step::Withhold),
        ("split_deposit", &|s| *s == Step::Split),
        ("publish_evidence", &|s| *s == Step::PublishEvidence),
        ("withdraw_owed", &|s| matches!(s, Step::Withdraw(..) | Step::Deliver | Step::DeliverTreasury)),
        ("close_swap", &|s| *s == Step::Close),
    ] {
        assert!(has(pred), "{name} is not walked");
    }
    // Both directions, every open kind.
    for kind in [Open::A, Open::AWindow, Open::AWatched, Open::B, Open::BWindow, Open::BPayout, Open::BWatched] {
        assert!(paths.iter().any(|(_, k, _)| *k == kind), "{kind:?}");
    }
}

/// The one place a switch touches a payout's route, spelled out: `split_mode` flipped between
/// the withhold and the split. The split, built for the mode in force when the swap was opened,
/// succeeds at the same second; the taker's half is paid; the treasury's half is parked for the
/// treasury (not failed, not paid to anybody else) and anyone delivers it under the new mode.
#[test]
fn a_split_mode_flipped_mid_flight_parks_the_treasury_half() {
    for asset in [ASSET_SOL, ASSET_USDC] {
        for mode in [0u8, 1] {
            let label = format!("asset {asset}, opened under split_mode {mode}");
            let mut r = open_in(Open::A, asset, mode);
            assert_eq!(r.built_for_mode, mode);
            step(&mut r, At::Now, Step::Refund).unwrap();
            step(&mut r, At::Now, Step::Withhold).unwrap();
            assert_eq!(r.w.swap(&r.fx.pda).unwrap().state, WITHHELD);
            // Only the flip (the full set of switches is in the walk above).
            let admin = r.w.admin.insecure_clone();
            let ix = r.w.admin_ix(&admin.pubkey(), Enc::ix("set_split_mode").u8(1 - mode).0);
            ok(r.w.send(&[ix], &[&admin]));
            let before = holdings(&r);
            let fee_payer = r.w.lamports(&r.w.stranger.pubkey());
            step(&mut r, At::Split, Step::Split).unwrap_or_else(|e| panic!("{label}: the split failed: {e}"));
            let s = r.w.swap(&r.fx.pda).unwrap();
            let half = D / 2;
            // One combination needs no parking: USDC flipped from "treasury" to "burn". A burn
            // needs only the mint and the swap's vault, which every split carries, so the half
            // is burned at once under the mode now in force. In the other three the account the
            // new mode pays is not the one the transaction carries, and the half is parked.
            let parked = if asset == ASSET_USDC && mode == 0 { 0 } else { D - half };
            assert_eq!((s.state, s.deposit_state, s.owed_taker, s.owed_treasury), (DONE, 5, 0, parked), "{label}: SPLIT");
            let after = holdings(&r);
            assert_eq!(after.taker - before.taker, half as i128, "{label}: the taker's half is paid");
            assert_eq!(after.treasury_or_burned - before.treasury_or_burned, (D - half - parked) as i128, "{label}: the other half is parked or burned");
            assert_eq!((after.maker_payout, after.operator, after.dest), (before.maker_payout, before.operator, before.dest));
            assert_eq!(fee_payer - r.w.lamports(&r.w.stranger.pubkey()), FEE, "{label}: the caller got nothing");
            // Nobody but the treasury's route can have it: a withdrawal for the taker or the
            // maker finds nothing owed.
            for who in [0u8, 1] {
                let signer = if who == 0 { key_of(&r, Who::Taker) } else { key_of(&r, Who::Owner) };
                let ix = r.w.call_ix(&r.m, &r.fx, &Call::WithdrawOwed(who), &signer.pubkey());
                assert_err(r.w.send(&[ix], &[&signer]), "NothingOwed");
            }
            step(&mut r, At::Now, Step::DeliverTreasury).unwrap_or_else(|e| panic!("{label}: delivery failed: {e}"));
            assert_eq!(r.w.swap(&r.fx.pda).unwrap().owed_treasury, 0, "{label}");
            assert_eq!(holdings(&r).treasury_or_burned - before.treasury_or_burned, (D - half) as i128, "{label}");
            step(&mut r, At::Now, Step::Close).unwrap();
        }
    }
}
