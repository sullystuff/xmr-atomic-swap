//! Replay of `interfaces/vectors/transitions.json` (SPEC 2.12, 9.1): every row and every
//! sequence whose chain is `solana`, against the built program, once with SOL and once with
//! USDC as the escrowed asset.
//!
//! The vectors come from the reference model in `swap-core`. For each step this checks: the
//! result (success, or the exact error name), the whole swap record (state, flags, outcome,
//! deposit state, every `t_*` field, the `owed_*` balances), the maker's counters and totals,
//! and every lamport and token that moved: escrow in, payouts paid, payouts parked, the
//! session-key sweep, rent returned on close. A step that must fail must change nothing.
//!
//! How the model's inputs map to the chain:
//! * `amount` is reached with 1 XMR at a price of `amount` per XMR.
//! * `offer_mode` 0..2 is an offer set with those terms; 3 is a `post_quote`.
//! * Rows whose terms violate a bound cannot be published (`set_offer` refuses them with the
//!   same error, which is asserted); the offer account is then written directly so that the
//!   `lock` / `take` check itself is what the row exercises.
//! * `approval: true` is an advance approval signed by the operator in an Ed25519 instruction.
//! * A destination that "cannot receive": USDC, a frozen token account; SOL, an executable
//!   account at that address (a payout address that is really a program: the one way a funded
//!   wallet fails the pay-or-park rule). The one exception is a direction-B refund on SOL,
//!   where the destination is the operator that signs and pays the fee and so cannot be
//!   executable: there the maker's destination is made unusable by naming another wallet in
//!   the `maker_wallet` slot, which the program also parks.
//! * `env.open_pending` and a sequence's `initial_maker` are written into the maker record.
use crate::common::*;
use serde_json::Value;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

const STATES: [&str; 10] =
    ["NONE", "PENDING", "ACTIVE", "NOTICED", "READY", "ABORTED_FREE", "ABORTED_HOLD", "HOLD", "WITHHELD", "DONE"];

struct Sim {
    asset: u8,
    m: MakerFx,
    fx: Option<SwapFx>,
}

/// Lamports and tokens of every account a step can touch.
#[derive(Clone, Debug, Default)]
struct Snap {
    taker: i128,
    session: i128,
    operator: i128,
    payout: i128,
    owner: i128,
    treasury: i128,
    stranger: i128,
    swap: i128,
    vault_lamports: i128,
    tok_taker: i128,
    tok_operator: i128,
    tok_payout: i128,
    tok_treasury: i128,
    tok_vault: i128,
}

fn snap(w: &World, sim: &Sim) -> Snap {
    let mut s = Snap {
        operator: w.lamports(&sim.m.operator.pubkey()) as i128,
        payout: w.lamports(&sim.m.payout.pubkey()) as i128,
        owner: w.lamports(&sim.m.owner.pubkey()) as i128,
        treasury: w.lamports(&w.treasury) as i128,
        stranger: w.lamports(&w.stranger.pubkey()) as i128,
        tok_operator: w.tokens(&w.ata(&sim.m.operator.pubkey())) as i128,
        tok_payout: w.tokens(&w.ata(&sim.m.payout.pubkey())) as i128,
        tok_treasury: w.tokens(&w.treasury_vault) as i128,
        ..Snap::default()
    };
    if let Some(fx) = &sim.fx {
        s.taker = w.lamports(&fx.taker.pubkey()) as i128;
        s.session = w.lamports(&fx.session.pubkey()) as i128;
        s.swap = w.lamports(&fx.pda) as i128;
        s.vault_lamports = w.lamports(&fx.vault) as i128;
        s.tok_taker = w.tokens(&w.ata(&fx.taker.pubkey())) as i128;
        s.tok_vault = w.tokens(&fx.vault) as i128;
    }
    s
}

fn diff(a: &Snap, b: &Snap) -> Snap {
    Snap {
        taker: b.taker - a.taker,
        session: b.session - a.session,
        operator: b.operator - a.operator,
        payout: b.payout - a.payout,
        owner: b.owner - a.owner,
        treasury: b.treasury - a.treasury,
        stranger: b.stranger - a.stranger,
        swap: b.swap - a.swap,
        vault_lamports: b.vault_lamports - a.vault_lamports,
        tok_taker: b.tok_taker - a.tok_taker,
        tok_operator: b.tok_operator - a.tok_operator,
        tok_payout: b.tok_payout - a.tok_payout,
        tok_treasury: b.tok_treasury - a.tok_treasury,
        tok_vault: b.tok_vault - a.tok_vault,
    }
}

fn role_key(w: &World, sim: &Sim, role: &str) -> Keypair {
    match role {
        "taker" => sim.fx.as_ref().expect("swap").taker.insecure_clone(),
        "session" => sim.fx.as_ref().expect("swap").session.insecure_clone(),
        "operator" => sim.m.operator.insecure_clone(),
        "owner" => sim.m.owner.insecure_clone(),
        "anyone" => w.stranger.insecure_clone(),
        other => panic!("unknown caller {other}"),
    }
}

/// Make each destination able or unable to receive (see the module docs).
fn apply_env(w: &mut World, sim: &Sim, env: &Value) {
    let can = |k: &str| env[k].as_bool().unwrap();
    let operator = sim.m.operator.pubkey();
    let payout = sim.m.payout.pubkey();
    let taker = sim.fx.as_ref().map(|fx| fx.taker.pubkey());
    if sim.asset == ASSET_USDC {
        if let Some(t) = taker {
            let ata = w.ata(&t);
            w.set_frozen(&ata, !can("taker_can_receive"));
        }
        for wallet in [operator, payout] {
            let ata = w.ata(&wallet);
            w.set_frozen(&ata, !can("maker_can_receive"));
        }
        let tv = w.treasury_vault;
        w.set_frozen(&tv, !can("treasury_can_receive"));
    } else {
        if let Some(t) = taker {
            w.set_can_receive_sol(&t, can("taker_can_receive"));
        }
        // The operator signs; see `wrong_maker_wallet`.
        w.set_can_receive_sol(&payout, can("maker_can_receive"));
        let t = w.treasury;
        w.set_can_receive_sol(&t, can("treasury_can_receive"));
    }
}

/// SOL, direction-B refund, "the maker cannot receive": see the module docs.
fn wrong_maker_wallet(sim: &Sim, step: &Value) -> bool {
    sim.asset == ASSET_SOL
        && step["call"] == "refund"
        && sim.fx.as_ref().is_some_and(|fx| fx.direction == DIR_B)
        && !step["env"]["maker_can_receive"].as_bool().unwrap()
}

fn terms_of(args: &Value) -> Terms {
    let mode = args["offer_mode"].as_u64().unwrap() as u8;
    Terms {
        mode: if mode == 3 { 0 } else { mode },
        depths: [args["depth"].as_u64().unwrap() as u8, 0, 0],
        dep_bps: args["dep_bps"].as_u64().unwrap() as u16,
        w_a: args["w_a"].as_u64().unwrap() as u32,
        w_n: args["w_n"].as_u64().unwrap() as u32,
        d_c: args["d_c"].as_u64().unwrap() as u32,
        w_c: args["w_c"].as_u64().unwrap() as u32,
        w_f: args["w_f"].as_u64().unwrap() as u32,
        ..Terms::default()
    }
}

/// What a step did, as far as the balance check needs.
struct Sent {
    res: TxResult,
    caller: String,
    call: String,
    /// Rent of a consumed quote, returned to the operator.
    quote_rent: i128,
    session_lamports: i128,
    /// Balances and the maker record just before the transaction.
    before: Snap,
    maker_before: MakerAcc,
}

fn send_open(w: &mut World, sim: &mut Sim, step: &Value) -> Result<Sent, String> {
    let args = &step["args"];
    let caller = step["caller"].as_str().unwrap().to_string();
    let direction = if args["direction"] == "A" { DIR_A } else { DIR_B };
    let amount = num(&args["amount"]);
    let offer_mode = args["offer_mode"].as_u64().unwrap() as u8;
    let terms = terms_of(args);
    let asset = sim.asset;
    let expect_err = step["expect"]["error"].as_str();

    // The maker's open_pending before the call.
    let want_pending = step["env"]["open_pending"].as_u64().unwrap() as u16;
    if w.maker(&sim.m.pda).open_pending != want_pending {
        w.patch(&sim.m.pda, |d| d[MAKER_OPEN_PENDING..MAKER_OPEN_PENDING + 2].copy_from_slice(&want_pending.to_le_bytes()));
    }

    let mut quote_rent = 0i128;
    let mut pre_ixs: Vec<Instruction> = vec![];
    let source;
    let taker = w.fund(1_000 * SOL);
    if asset == ASSET_USDC {
        w.mint_to(&taker.pubkey(), 1_000_000_000_000);
    }
    if offer_mode == 3 {
        let (share, pok) = if direction == DIR_A {
            let (_, s_pub, pok) = sim.m.new_share();
            (s_pub, pok)
        } else {
            ([0; 32], [0; 64])
        };
        let quote_id = u64::from_le_bytes(rand32()[..8].try_into().unwrap());
        let (ix, quote) =
            w.post_quote_ix(&sim.m, quote_id, &taker.pubkey(), asset, direction, XMR, amount, &terms, &share, &pok, w.now() + 60);
        let op = sim.m.operator.insecure_clone();
        w.send(&[ix], &[&op]).map_err(|e| format!("post_quote failed: {:?}", e.err))?;
        quote_rent = w.lamports(&quote) as i128;
        source = Source::Quote(quote, sim.m.operator.pubkey());
    } else {
        // 1 XMR at `amount` per XMR.
        match w.set_offer(&sim.m, asset, direction, &terms) {
            Ok(_) => {
                ok(w.refresh(&sim.m, &[(asset, direction, true, [amount, 0, 0], 1_000_000 * XMR)]));
                if direction == DIR_A {
                    ok(w.refill(&mut sim.m, asset, 0, 2));
                }
            }
            Err(e) => {
                // Terms that cannot be published: set_offer must refuse them for the reason
                // the row gives, and lock/take must refuse them too.
                let name = expect_err.ok_or_else(|| format!("set_offer refused terms of a row that must succeed: {:?}", e.err))?;
                if !format!("{:?}", e.err).contains(&format!("Custom({})", error_code(name))) {
                    return Err(format!("set_offer: expected {name}, got {:?}", e.err));
                }
                w.craft_offer(&mut sim.m, asset, direction, &terms, amount);
            }
        }
        source = Source::Offer(w.offer_pda(&sim.m.pda, asset, direction));
    }

    let (fx, mut raw) = w.prepare_open_for(&sim.m, taker, asset, direction, XMR, source, rand16());
    if args["approval"].as_bool().unwrap() {
        pre_ixs.push(w.approval_ix(&sim.m, &fx.taker.pubkey(), asset, direction, XMR));
        raw.approval_ix = Some(0);
        raw.sysvar = Some(IX_SYSVAR);
    }
    let session_lamports = raw.session_lamports as i128;
    sim.fx = Some(fx);
    apply_env(w, sim, &step["env"]);
    let signer = role_key(w, sim, &caller);
    if caller != "taker" {
        // Anyone else can only submit the instruction without the taker's signature.
        raw.taker_signs = false;
        if w.lamports(&signer.pubkey()) < SOL {
            w.svm.airdrop(&signer.pubkey(), SOL).unwrap();
        }
    }
    let before = snap(w, sim);
    let maker_before = w.maker(&sim.m.pda);
    pre_ixs.push(w.open_ix(&raw));
    let res = w.send(&pre_ixs, &[&signer]);
    Ok(Sent { res, caller, call: step["call"].as_str().unwrap().to_string(), quote_rent, session_lamports, before, maker_before })
}

fn build_call(w: &World, sim: &mut Sim, step: &Value) -> (Call, Option<([u8; 32], [u8; 32])>) {
    let args = &step["args"];
    let fx = sim.fx.as_ref().expect("swap");
    let on_chain = w.swap(&fx.pda);
    let open = |ok: bool| match (&on_chain, ok) {
        (Some(s), true) => s.open_hash(&fx.pda),
        _ => rand32(),
    };
    let maker_secret = || {
        on_chain.as_ref().and_then(|s| sim.m.shares.get(&s.maker_spend_pub).copied()).unwrap_or_else(|| new_share().0)
    };
    let is_a = fx.direction == DIR_A;
    let mut new_notice = None;
    let call = match step["call"].as_str().unwrap() {
        "approve" => {
            let (s, s_pub) = new_share();
            let pok = pok_prove(&s, &sim.m.pda.to_bytes());
            sim.m.shares.insert(s_pub, s);
            Call::Approve { open: open(args["open_ok"].as_bool().unwrap()), share: s_pub, pok }
        }
        "fund" => {
            let (s, s_pub) = new_share();
            let pok = pok_prove(&s, &sim.m.pda.to_bytes());
            sim.m.shares.insert(s_pub, s);
            Call::Fund { open: open(args["open_ok"].as_bool().unwrap()), share: s_pub, pok, view: new_view() }
        }
        "reject" => Call::Reject { open: open(args["open_ok"].as_bool().unwrap()), reason: args["reason"].as_u64().unwrap() as u8 },
        "cancel_pending" => Call::CancelPending,
        "expire_pending" => Call::ExpirePending,
        "post_notice" => {
            let (txid, view) = (rand32(), new_view());
            new_notice = Some((txid, view));
            Call::PostNotice { commitment: notice_commitment(&fx.pda, &txid, &view), ct: [7; 104] }
        }
        "set_ready" => Call::SetReady,
        "abort" => Call::Abort,
        "refund_unnoticed" => Call::RefundUnnoticed,
        "expire_unnoticed" => Call::ExpireUnnoticed,
        "refund" => {
            let right = if is_a { fx.s_t } else { maker_secret() };
            Call::Refund(if args["secret_ok"].as_bool().unwrap() { right } else { new_share().0 })
        }
        "claim" => {
            let right = if is_a { maker_secret() } else { fx.s_t };
            Call::Claim(if args["secret_ok"].as_bool().unwrap() { right } else { new_share().0 })
        }
        "release_deposit" => Call::ReleaseDeposit,
        "withhold" => Call::Withhold(match args["evidence"].as_str().unwrap() {
            "absent" => None,
            "opens" => Some(fx.notice.unwrap_or((rand32(), new_view()))),
            "mismatch" => Some((rand32(), new_view())),
            other => panic!("evidence {other}"),
        }),
        "split_deposit" => Call::SplitDeposit,
        "publish_evidence" => {
            let (txid, view) = if args["opens"].as_bool().unwrap() {
                fx.notice.unwrap_or((rand32(), new_view()))
            } else {
                (rand32(), new_view())
            };
            Call::PublishEvidence(txid, view)
        }
        "withdraw_owed" => Call::WithdrawOwed(match args["who"].as_str().unwrap() {
            "taker" => 0,
            "maker" => 1,
            "treasury" => 2,
            other => panic!("who {other}"),
        }),
        other => panic!("unknown call {other}"),
    };
    (call, new_notice)
}

fn check_swap(got: &SwapAcc, want: &Value, what: &str) -> Result<(), String> {
    let mut errs = vec![];
    let mut cmp = |name: &str, g: i128, w: i128| {
        if g != w {
            errs.push(format!("{name}: got {g}, want {w}"));
        }
    };
    cmp("state", got.state as i128, want["state_code"].as_i64().unwrap() as i128);
    cmp("direction", got.direction as i128, if want["direction"] == "A" { 0 } else { 1 });
    cmp("mode", got.mode as i128, inum(&want["mode"]) as i128);
    cmp("outcome", got.outcome as i128, inum(&want["outcome"]) as i128);
    cmp("deposit_state", got.deposit_state as i128, inum(&want["deposit_state"]) as i128);
    cmp("depth", got.depth as i128, inum(&want["depth"]) as i128);
    cmp("flags", got.flags as i128, inum(&want["flags"]) as i128);
    cmp("amount", got.amount as i128, num(&want["amount"]) as i128);
    cmp("deposit", got.deposit as i128, num(&want["deposit"]) as i128);
    cmp("fee_bps", got.fee_bps as i128, inum(&want["fee_bps"]) as i128);
    cmp("w_n", got.w_n as i128, inum(&want["w_n"]) as i128);
    cmp("d_c", got.d_c as i128, inum(&want["d_c"]) as i128);
    cmp("w_c", got.w_c as i128, inum(&want["w_c"]) as i128);
    cmp("t_lock", got.t_lock as i128, inum(&want["t_lock"]) as i128);
    cmp("t_pending_deadline", got.t_pending_deadline as i128, inum(&want["t_pending_deadline"]) as i128);
    cmp("t_active", got.t_active as i128, inum(&want["t_active"]) as i128);
    cmp("t_note_deadline", got.t_note_deadline as i128, inum(&want["t_note_deadline"]) as i128);
    cmp("t_notice", got.t_notice as i128, inum(&want["t_notice"]) as i128);
    cmp("t_cut", got.t_cut as i128, inum(&want["t_cut"]) as i128);
    cmp("t_claim_open", got.t_claim_open as i128, inum(&want["t_claim_open"]) as i128);
    cmp("t_ready", got.t_ready as i128, inum(&want["t_ready"]) as i128);
    cmp("t_claim_deadline", got.t_claim_deadline as i128, inum(&want["t_claim_deadline"]) as i128);
    cmp("t_final", got.t_final as i128, inum(&want["t_final"]) as i128);
    cmp("t_refund", got.t_refund as i128, inum(&want["t_refund"]) as i128);
    cmp("t_settled", got.t_settled as i128, inum(&want["t_settled"]) as i128);
    cmp("owed_taker", got.owed_taker as i128, num(&want["owed_taker"]) as i128);
    cmp("owed_maker", got.owed_maker as i128, num(&want["owed_maker"]) as i128);
    cmp("owed_treasury", got.owed_treasury as i128, num(&want["owed_treasury"]) as i128);
    if want["state"].as_str().unwrap() != STATES[got.state as usize] && !errs.iter().any(|e| e.starts_with("state")) {
        errs.push(format!("state name {} vs code {}", want["state"], got.state));
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(format!("{what}: {}", errs.join("; ")))
    }
}

/// Run one step at its time and compare everything with `expect` (if the step has one; a
/// setup step without one must simply succeed).
fn run_step(w: &mut World, sim: &mut Sim, step: &Value) -> Result<(), String> {
    let call_name = step["call"].as_str().unwrap();
    let label = format!("{} by {} at {}", call_name, step["caller"].as_str().unwrap(), step["at"]);
    w.set_time(inum(&step["at"]));
    let expect = step.get("expect");
    let is_open = call_name == "lock" || call_name == "take";

    let mut swap_before_bytes = vec![];
    let mut new_notice = None;
    let mut call_built = None;

    let sent = if is_open {
        send_open(w, sim, step).map_err(|e| format!("{label}: {e}"))?
    } else {
        apply_env(w, sim, &step["env"]);
        let (call, notice) = build_call(w, sim, step);
        new_notice = notice;
        let signer = role_key(w, sim, step["caller"].as_str().unwrap());
        // A session key that an earlier call swept to zero cannot pay a fee. Anyone can send it
        // lamports again; do so, so that the program (not the fee check) answers the call.
        if step["caller"] == "session" && w.lamports(&signer.pubkey()) == 0 {
            w.svm.airdrop(&signer.pubkey(), w.rent(0) + 100_000).unwrap();
        }
        // `fund` names the caller's own token account as the source: make sure it exists, so a
        // wrong caller is refused for being the wrong caller.
        if call_name == "fund" && sim.asset == ASSET_USDC {
            w.make_ata(&signer.pubkey());
        }
        let before = snap(w, sim);
        let maker_before = w.maker(&sim.m.pda);
        let fx = sim.fx.as_ref().unwrap();
        swap_before_bytes = w.data(&fx.pda);
        let mut ix = w.call_ix(&sim.m, fx, &call, &signer.pubkey());
        if wrong_maker_wallet(sim, step) {
            ix.accounts[S_MAKER_WALLET].pubkey = sim.m.payout.pubkey();
        }
        let res = w.send(&[ix], &[&signer]);
        call_built = Some(call);
        Sent {
            res,
            caller: step["caller"].as_str().unwrap().to_string(),
            call: call_name.to_string(),
            quote_rent: 0,
            session_lamports: 0,
            before,
            maker_before,
        }
    };
    let before = sent.before.clone();
    let maker_before = sent.maker_before.clone();

    let Some(expect) = expect else {
        return match &sent.res {
            Ok(_) => {
                if let (Some(n), Some(fx)) = (new_notice, sim.fx.as_mut()) {
                    fx.notice = Some(n);
                }
                Ok(())
            }
            Err(e) => Err(format!("{label}: setup step failed: {:?}\n{}", e.err, e.meta.pretty_logs())),
        };
    };

    let fx = sim.fx.as_ref().unwrap();
    if !expect["ok"].as_bool().unwrap() {
        let name = expect["error"].as_str().unwrap();
        if !is_err(&sent.res, name) {
            let logs = match &sent.res {
                Ok(m) => m.pretty_logs(),
                Err(e) => e.meta.pretty_logs(),
            };
            return Err(format!("{label}: expected {name}, got {}\n{logs}", err_string(&sent.res)));
        }
        // A refused call changes nothing.
        if is_open {
            if w.swap(&fx.pda).is_some() {
                return Err(format!("{label}: a refused open left a swap account"));
            }
        } else if w.data(&fx.pda) != swap_before_bytes {
            return Err(format!("{label}: a refused call changed the swap"));
        }
        if w.maker(&sim.m.pda) != maker_before {
            return Err(format!("{label}: a refused call changed the maker record"));
        }
        return Ok(());
    }

    let meta = match &sent.res {
        Ok(m) => m.clone(),
        Err(e) => return Err(format!("{label}: expected success, got {:?}\n{}", e.err, e.meta.pretty_logs())),
    };
    if let (Some(n), Some(fx)) = (new_notice, sim.fx.as_mut()) {
        fx.notice = Some(n);
    }
    let fx = sim.fx.as_ref().unwrap();
    let closed = expect["closed"].as_bool().unwrap();
    let asset = sim.asset;
    let usdc = asset == ASSET_USDC;

    // ---- the swap record
    let on_chain = w.swap(&fx.pda);
    if closed {
        if on_chain.is_some() || w.lamports(&fx.pda) != 0 {
            return Err(format!("{label}: the row closes the swap, but the account is still there"));
        }
        if usdc && w.exists(&fx.vault) {
            return Err(format!("{label}: the swap closed but its vault is still there"));
        }
    } else {
        let got = on_chain.ok_or_else(|| format!("{label}: the swap account is gone"))?;
        check_swap(&got, &expect["swap"], &label)?;
        if got.asset != asset || got.taker != fx.taker.pubkey() || got.maker != sim.m.pda {
            return Err(format!("{label}: wrong asset, taker or maker in the swap"));
        }
        // What the model cannot see: the secret and the evidence are account state.
        match call_built.as_ref() {
            Some(Call::Refund(s)) | Some(Call::Claim(s)) if got.revealed != *s => {
                return Err(format!("{label}: the revealed scalar is not in the account"));
            }
            Some(Call::Withhold(Some((txid, view)))) if fx.direction == DIR_A && got.flags & 1 != 0 => {
                if got.evidence_txid != *txid || got.evidence_view != *view {
                    return Err(format!("{label}: the evidence is not in the account"));
                }
            }
            Some(Call::PublishEvidence(txid, view)) if got.evidence_txid != *txid || got.evidence_view != *view => {
                return Err(format!("{label}: the evidence is not in the account"));
            }
            Some(Call::PostNotice { commitment, ct }) if got.notice_commitment != *commitment || got.notice_ct != ct.to_vec() => {
                return Err(format!("{label}: the notice is not in the account"));
            }
            _ => {}
        }
    }

    // ---- the maker record
    let maker_after = w.maker(&sim.m.pda);
    let a = asset as usize;
    let mut want = maker_before.clone();
    if let Some(c) = expect["counter"].as_u64() {
        want.counters[c as usize] = want.counters[c as usize].saturating_add(1);
    }
    if let Some(secs) = expect["response_secs"].as_u64() {
        want.response_secs_sum = want.response_secs_sum.saturating_add(secs);
    }
    want.volume[a] = want.volume[a].saturating_add(num(&expect["volume"]));
    want.withheld_volume[a] = want.withheld_volume[a].saturating_add(num(&expect["withheld_volume"]));
    want.open_pending = (want.open_pending as i64 + expect["open_pending"].as_i64().unwrap()).max(0) as u16;
    if maker_after != want {
        return Err(format!(
            "{label}: maker record: counters {:?} (want {:?}), open_pending {} ({}), response {} ({}), volume {:?} ({:?}), withheld {:?} ({:?})",
            maker_after.counters, want.counters, maker_after.open_pending, want.open_pending,
            maker_after.response_secs_sum, want.response_secs_sum, maker_after.volume, want.volume,
            maker_after.withheld_volume, want.withheld_volume
        ));
    }
    if let Some(mk) = expect.get("maker") {
        let counters: Vec<u32> = mk["counters"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap() as u32).collect();
        if counters != maker_after.counters.to_vec()
            || mk["open_pending"].as_u64().unwrap() as u16 != maker_after.open_pending
            || num(&mk["response_secs_sum"]) != maker_after.response_secs_sum
            || num(&mk["volume"]) != maker_after.volume[a]
            || num(&mk["withheld_volume"]) != maker_after.withheld_volume[a]
        {
            return Err(format!("{label}: maker record differs from the sequence's absolute values: {maker_after:?} vs {mk}"));
        }
    }

    // ---- funds
    let after = snap(w, sim);
    let got = diff(&before, &after);
    let mut want = Snap::default();
    let fee = meta.fee as i128;
    match sent.caller.as_str() {
        "taker" => want.taker -= fee,
        "session" => want.session -= fee,
        "operator" => want.operator -= fee,
        "owner" => want.owner -= fee,
        "anyone" => want.stranger -= fee,
        _ => unreachable!(),
    }
    let escrow_in = num(&expect["escrow_in"]) as i128;
    let swap_rent = w.rent(736) as i128;
    let vault_rent = w.rent(165) as i128;
    if is_open {
        want.swap += swap_rent;
        want.session += sent.session_lamports;
        want.taker -= swap_rent + sent.session_lamports;
        want.operator += sent.quote_rent;
        if usdc {
            want.taker -= vault_rent;
            want.vault_lamports += vault_rent;
            want.tok_taker -= escrow_in;
            want.tok_vault += escrow_in;
        } else {
            want.taker -= escrow_in;
            want.swap += escrow_in;
        }
    } else if sent.call == "fund" {
        if usdc {
            want.tok_operator -= escrow_in;
            want.tok_vault += escrow_in;
        } else {
            want.operator -= escrow_in;
            want.swap += escrow_in;
        }
    } else if escrow_in != 0 {
        return Err(format!("{label}: unexpected escrow_in"));
    }
    for p in expect["payouts"].as_array().unwrap() {
        if p["parked"].as_bool().unwrap() {
            continue;
        }
        let amount = num(&p["amount"]) as i128;
        // The maker is paid at its payout wallet on a claim (and when the owner pulls a parked
        // payout there), at its operator on a refund.
        let maker_at_operator = sent.call == "refund";
        if usdc {
            want.tok_vault -= amount;
            match p["to"].as_str().unwrap() {
                "taker" => want.tok_taker += amount,
                "treasury" => want.tok_treasury += amount,
                "maker" if maker_at_operator => want.tok_operator += amount,
                "maker" => want.tok_payout += amount,
                other => panic!("payout to {other}"),
            }
        } else {
            want.swap -= amount;
            match p["to"].as_str().unwrap() {
                "taker" => want.taker += amount,
                "treasury" => want.treasury += amount,
                "maker" if maker_at_operator => want.operator += amount,
                "maker" => want.payout += amount,
                other => panic!("payout to {other}"),
            }
        }
    }
    // The session-key sweep: every lamport left after the fee, to the taker (or into the swap
    // account when the taker's wallet cannot hold lamports).
    let sweeps = sent.caller == "session"
        && (sent.call == "cancel_pending"
            || (sent.call == "refund" && fx.direction == DIR_A)
            || (sent.call == "claim" && fx.direction == DIR_B));
    if sweeps {
        let left = before.session - fee;
        want.session -= left;
        let taker_holds_lamports = usdc || step["env"]["taker_can_receive"].as_bool().unwrap();
        if taker_holds_lamports {
            want.taker += left;
        } else {
            want.swap += left;
        }
    }
    if closed {
        // Everything left in the swap (and the vault's rent) returns to the taker.
        let rest = before.swap + want.swap;
        want.swap -= rest;
        want.taker += rest;
        if usdc {
            want.taker += before.vault_lamports;
            want.vault_lamports -= before.vault_lamports;
        }
    }
    let pairs = [
        ("taker", got.taker, want.taker),
        ("session", got.session, want.session),
        ("operator", got.operator, want.operator),
        ("payout wallet", got.payout, want.payout),
        ("owner", got.owner, want.owner),
        ("treasury", got.treasury, want.treasury),
        ("stranger", got.stranger, want.stranger),
        ("swap account", got.swap, want.swap),
        ("vault rent", got.vault_lamports, want.vault_lamports),
        ("taker tokens", got.tok_taker, want.tok_taker),
        ("operator tokens", got.tok_operator, want.tok_operator),
        ("payout tokens", got.tok_payout, want.tok_payout),
        ("treasury tokens", got.tok_treasury, want.tok_treasury),
        ("vault tokens", got.tok_vault, want.tok_vault),
    ];
    let wrong: Vec<String> =
        pairs.iter().filter(|(_, g, w)| g != w).map(|(n, g, w)| format!("{n}: moved {g}, want {w}")).collect();
    if !wrong.is_empty() {
        return Err(format!("{label}: funds: {}", wrong.join("; ")));
    }
    Ok(())
}

fn new_sim(w: &mut World, asset: u8) -> Sim {
    Sim { asset, m: w.register_maker(), fx: None }
}

fn run_row(w: &mut World, asset: u8, row: &Value) -> Result<(), String> {
    let mut sim = new_sim(w, asset);
    if let Some(open) = row.get("open") {
        run_step(w, &mut sim, open)?;
    }
    for s in row["setup"].as_array().unwrap() {
        run_step(w, &mut sim, s)?;
    }
    if let Some(from) = row.get("from") {
        let fx = sim.fx.as_ref().unwrap();
        let got = w.swap(&fx.pda).ok_or("the swap is gone before the step")?;
        check_swap(&got, from, "from")?;
    }
    run_step(w, &mut sim, &row["step"])
}

fn run_sequence(w: &mut World, asset: u8, seq: &Value) -> Result<(), String> {
    let mut sim = new_sim(w, asset);
    // Start the maker record at `initial_maker`.
    let init = &seq["initial_maker"];
    let a = asset as usize;
    w.patch(&sim.m.pda, |d| {
        for (i, c) in init["counters"].as_array().unwrap().iter().enumerate() {
            d[MAKER_COUNTERS + 4 * i..MAKER_COUNTERS + 4 * i + 4].copy_from_slice(&(c.as_u64().unwrap() as u32).to_le_bytes());
        }
        d[MAKER_OPEN_PENDING..MAKER_OPEN_PENDING + 2].copy_from_slice(&(init["open_pending"].as_u64().unwrap() as u16).to_le_bytes());
        d[MAKER_RESPONSE..MAKER_RESPONSE + 8].copy_from_slice(&num(&init["response_secs_sum"]).to_le_bytes());
        d[MAKER_VOLUME + 8 * a..MAKER_VOLUME + 8 * a + 8].copy_from_slice(&num(&init["volume"]).to_le_bytes());
        d[MAKER_WITHHELD + 8 * a..MAKER_WITHHELD + 8 * a + 8].copy_from_slice(&num(&init["withheld_volume"]).to_le_bytes());
    });
    for (i, s) in seq["steps"].as_array().unwrap().iter().enumerate() {
        run_step(w, &mut sim, s).map_err(|e| format!("step {i}: {e}"))?;
    }
    // The final record.
    let fin = &seq["final"];
    let fx = sim.fx.as_ref().unwrap();
    if let Some(got) = w.swap(&fx.pda) {
        check_swap(&got, &fin["swap"], "final")?;
    }
    let mk = w.maker(&sim.m.pda);
    let counters: Vec<u32> = fin["maker"]["counters"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap() as u32).collect();
    if counters != mk.counters.to_vec()
        || num(&fin["maker"]["response_secs_sum"]) != mk.response_secs_sum
        || num(&fin["maker"]["volume"]) != mk.volume[a]
        || num(&fin["maker"]["withheld_volume"]) != mk.withheld_volume[a]
        || fin["maker"]["open_pending"].as_u64().unwrap() as u16 != mk.open_pending
    {
        return Err(format!("final maker record: {mk:?} vs {}", fin["maker"]));
    }
    Ok(())
}

fn solana<'a>(v: &'a Value, key: &str) -> Vec<&'a Value> {
    v[key].as_array().unwrap().iter().filter(|x| x["chain"] == "solana" || x["chain"] == "both").collect()
}

fn replay_rows(asset: u8) {
    let v = vectors("transitions");
    let rows = solana(&v, "rows");
    assert_eq!(rows.len() as u64, v["summary"]["solana"]["rows"].as_u64().unwrap(), "every Solana row");
    let mut w = World::new();
    let mut failures = vec![];
    let (mut accepted, mut refused) = (0, 0);
    for row in &rows {
        match run_row(&mut w, asset, row) {
            Ok(()) if row["ok"].as_bool().unwrap() => accepted += 1,
            Ok(()) => refused += 1,
            Err(e) => failures.push(format!("[{} | {} | dir {} | from {}] {e}", row["id"], row["case"], row["direction"], row["from_state"])),
        }
    }
    println!("transitions.json rows, asset {asset}: {accepted} accepted, {refused} refused, {} failed", failures.len());
    assert!(failures.is_empty(), "{} of {} rows failed:\n{}", failures.len(), rows.len(), failures.join("\n"));
    assert_eq!(refused as u64, v["summary"]["solana"]["rows_rejected"].as_u64().unwrap());
}

fn replay_sequences(asset: u8) {
    let v = vectors("transitions");
    let seqs = solana(&v, "sequences");
    assert_eq!(seqs.len() as u64, v["summary"]["solana"]["sequences"].as_u64().unwrap(), "every Solana sequence");
    let mut w = World::new();
    let mut failures = vec![];
    let mut steps = 0;
    for seq in &seqs {
        steps += seq["steps"].as_array().unwrap().len();
        if let Err(e) = run_sequence(&mut w, asset, seq) {
            failures.push(format!("[{}] {e}", seq["name"]));
        }
    }
    println!("transitions.json sequences, asset {asset}: {} sequences, {steps} steps, {} failed", seqs.len(), failures.len());
    assert!(failures.is_empty(), "{} of {} sequences failed:\n{}", failures.len(), seqs.len(), failures.join("\n"));
}

#[test]
fn transitions_rows_sol() {
    replay_rows(ASSET_SOL);
}
#[test]
fn transitions_rows_usdc() {
    replay_rows(ASSET_USDC);
}
#[test]
fn transitions_sequences_sol() {
    replay_sequences(ASSET_SOL);
}
#[test]
fn transitions_sequences_usdc() {
    replay_sequences(ASSET_USDC);
}

/// The vectors themselves: both chains present, nothing marked `both` that this replay would
/// have to reinterpret, and the row count the generator reports.
#[test]
fn transitions_file_shape() {
    let v = vectors("transitions");
    assert_eq!(v["format"], "xmrswap-vectors/1");
    assert_eq!(v["t0"].as_i64().unwrap(), T0);
    assert_eq!(solana(&v, "rows").len(), 399);
    assert_eq!(solana(&v, "sequences").len(), 182);
}
