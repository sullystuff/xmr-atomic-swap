//! Advance approvals (SPEC 2.9, 4.6): the Ed25519-precompile path that was WP2's spike, and
//! every case of `sol_signed.json`.
//!
//! The vectors are signed for a placeholder program id, maker and taker. An approval is bound
//! to the real ones, so each case is replayed twice: (1) byte for byte against this harness's
//! encoder and against the runtime's Ed25519 precompile; (2) through `lock` / `take`, with the
//! placeholder bindings replaced by the real program id, maker PDA and taker (a field the case
//! makes *wrong* stays wrong), signed with the vectors' operator seed, at the case's chain time,
//! asset, direction, size and epoch.
use crate::common::*;
use serde_json::Value;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn cases() -> (Value, Vec<Value>) {
    let v = vectors("sol_signed");
    let cases = v["cases"].as_array().unwrap().clone();
    (v, cases)
}

fn vector_operator(v: &Value) -> Keypair {
    let kp = Keypair::new_from_array(h32(&v["operator_seed"]));
    assert_eq!(kp.pubkey().to_bytes(), h32(&v["operator_pub"]), "the seed gives the vectors' operator key");
    kp
}

/// The message of a case: given, or encoded from its fields (and then equal to the vector's).
fn case_message(case: &Value) -> Vec<u8> {
    let input = &case["input"];
    if let Some(a) = input.get("approval") {
        let fields = ApprovalFields {
            cluster_tag: h32(&a["cluster_tag"]),
            program_id: h32(&a["program_id"]),
            maker: h32(&a["maker"]),
            taker: h32(&a["taker"]),
            asset: a["asset"].as_u64().unwrap() as u8,
            direction: a["direction"].as_u64().unwrap() as u8,
            max_xmr: num(&a["max_xmr"]),
            not_before: inum(&a["not_before"]),
            expires_at: inum(&a["expires_at"]),
            epoch: a["epoch"].as_u64().unwrap() as u32,
            approval_id: num(&a["approval_id"]),
        };
        let msg = encode_approval(&fields);
        assert_eq!(msg, h(&case["output"]["message"]), "{}: encoder", case["name"]);
        msg
    } else {
        h(&input["message"])
    }
}

fn approval_cases(cases: &[Value]) -> Vec<&Value> {
    cases.iter().filter(|c| c["input"].get("lock").is_some()).collect()
}

#[test]
fn vectors_match_the_encoder_the_signer_and_the_instruction_layout() {
    let (v, cases) = cases();
    assert_eq!(v["message_len"], 190);
    let operator = vector_operator(&v);
    let mut checked = 0;
    for case in approval_cases(&cases) {
        let msg = case_message(case);
        if let Some(out) = case.get("output") {
            // Ed25519 signatures are deterministic: the same seed and message give these bytes.
            assert_eq!(operator.sign_message(&msg).as_ref(), &h(&out["signature"])[..], "{}", case["name"]);
            assert_eq!(
                ed25519_data(&h32(&out["operator_pub"]), &h(&out["signature"]), &msg),
                h(&out["ed25519_instruction_data"]),
                "{}: instruction data layout",
                case["name"]
            );
            assert_eq!(h(&out["ed25519_instruction_data"]).len(), 302);
            checked += 1;
        }
    }
    assert!(checked >= 10, "{checked}");
}

/// The spike of SPEC 4.6: the runtime's precompile accepts the vectors' instruction data as is
/// and refuses the tampered signature.
#[test]
fn spike_precompile_verifies_vector_instructions_verbatim() {
    let (v, cases) = cases();
    let mut w = World::new();
    let payer = w.fund(SOL);
    let mut verified = 0;
    for case in approval_cases(&cases) {
        let input = &case["input"];
        let (data, must_verify) = match case.get("output") {
            Some(out) => (h(&out["ed25519_instruction_data"]), true),
            None => {
                let msg = h(&input["message"]);
                (
                    ed25519_data(&h32(&input["signer_pub"]), &h(&input["signature"]), &msg),
                    case["error"] != "SignatureInvalid",
                )
            }
        };
        let res = w.send(&[Instruction { program_id: ED25519, accounts: vec![], data }], &[&payer]);
        assert_eq!(res.is_ok(), must_verify, "{}: {}", case["name"], err_string(&res));
        verified += must_verify as u32;
    }
    assert_eq!(verified, 19, "every case but the tampered signature passes the precompile");
    let _ = v;
}

/// One world per case: the vectors' cluster tag and operator, the case's epoch, an ADVANCE offer
/// on the case's market (so only a valid approval can open a swap).
fn replay_case(v: &Value, base: &Value, case: &Value) -> Result<(), String> {
    let name = case["name"].as_str().unwrap();
    let lock = &case["input"]["lock"];
    let asset = lock["asset"].as_u64().unwrap() as u8;
    let direction = lock["direction"].as_u64().unwrap() as u8;
    let xmr = num(&lock["xmr"]);
    let epoch = lock["approval_epoch"].as_u64().unwrap();

    let mut w = World::with(h32(&base["cluster_tag"]), 0);
    w.set_time(inum(&lock["now"]));
    let operator = vector_operator(v);
    w.svm.airdrop(&operator.pubkey(), 1_000 * SOL).unwrap();
    let mut m = w.register_maker_with(operator);
    for _ in 0..epoch {
        ok(w.bump_epochs(&m, true, false));
    }
    assert_eq!(w.maker(&m.pda).approval_epoch as u64, epoch);
    let terms = Terms { mode: 2, max_xmr: 100 * XMR, ..Terms::default() };
    let offer = w.live_offer(&mut m, asset, direction, &terms, 2 * XMR);

    let taker = w.fund(50_000 * SOL);
    if asset == ASSET_USDC {
        w.mint_to(&taker.pubkey(), 50_000_000_000_000);
    }
    let (fx, mut raw) = w.prepare_open_for(&m, taker, asset, direction, xmr, Source::Offer(offer), rand16());

    // Rebind: a field that equals the vectors' placeholder becomes the real value; a field the
    // case made wrong stays wrong.
    let mut msg = case_message(case);
    let mut rebind = |at: usize, placeholder: &[u8; 32], real: [u8; 32]| {
        if msg.len() >= at + 32 && msg[at..at + 32] == placeholder[..] {
            msg[at..at + 32].copy_from_slice(&real);
        }
    };
    rebind(56, &h32(&base["program_id"]), PROGRAM_ID.to_bytes());
    rebind(88, &h32(&base["maker"]), m.pda.to_bytes());
    rebind(120, &h32(&base["taker"]), fx.taker.pubkey().to_bytes());

    let signer = match case["input"].get("signer_pub") {
        Some(p) if h32(p) != h32(&v["operator_pub"]) => Keypair::new(),
        _ => m.operator.insecure_clone(),
    };
    let mut ed = ed25519_ix(&signer, &msg);
    if case["error"] == "SignatureInvalid" {
        ed.data[48 + 5] ^= 0x01; // one bit of the signature
    }
    raw.approval_ix = Some(0);
    raw.sysvar = Some(IX_SYSVAR);
    let res = w.send(&[ed, w.open_ix(&raw)], &[&fx.taker]);

    if case["valid"].as_bool().unwrap() {
        if let Err(e) = &res {
            return Err(format!("{name}: must lock, got {:?}\n{}", e.err, e.meta.pretty_logs()));
        }
        let s = w.swap(&fx.pda).ok_or(format!("{name}: no swap"))?;
        // A valid approval on an ADVANCE offer is treated as AUTO: effective mode 2, bound at once.
        let want_state = if direction == DIR_A { ACTIVE } else { PENDING };
        if (s.mode, s.state, s.xmr) != (2, want_state, xmr) {
            return Err(format!("{name}: mode {} state {} xmr {}", s.mode, s.state, s.xmr));
        }
        if direction == DIR_B && s.t_pending_deadline != s.t_lock + s.w_n as i64 {
            return Err(format!("{name}: an approved take waits W_n for the maker's funds"));
        }
        return Ok(());
    }
    if w.swap(&fx.pda).is_some() {
        return Err(format!("{name}: a swap was opened"));
    }
    match case["error"].as_str().unwrap() {
        // The precompile fails the whole transaction; the program never runs.
        "SignatureInvalid" => match &res {
            Err(e) if !format!("{:?}", e.err).contains("Custom(60") => Ok(()),
            other => Err(format!("{name}: expected a precompile failure, got {}", err_string(other))),
        },
        program_error => {
            if is_err(&res, program_error) {
                Ok(())
            } else {
                Err(format!("{name}: expected {program_error}, got {}", err_string(&res)))
            }
        }
    }
}

#[test]
fn every_sol_signed_case_through_lock_and_take() {
    let (v, cases) = cases();
    let base = cases.iter().find(|c| c["name"] == "at-not-before").unwrap()["input"]["approval"].clone();
    let list = approval_cases(&cases);
    assert_eq!(list.len(), 20);
    let failures: Vec<String> = list.iter().filter_map(|c| replay_case(&v, &base, c).err()).collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    let valid = list.iter().filter(|c| c["valid"].as_bool().unwrap()).count();
    println!("sol_signed.json: {} approval cases replayed through lock/take ({valid} valid)", list.len());
}

#[test]
fn open_hash_vectors() {
    let (_, cases) = cases();
    let mut n = 0;
    for case in cases.iter().filter(|c| c["name"].as_str().unwrap().starts_with("open-hash")) {
        let i = &case["input"];
        let got = open_hash_of(
            &h32(&i["swap"]),
            inum(&i["t_lock"]),
            i["direction"].as_u64().unwrap() as u8,
            i["asset"].as_u64().unwrap() as u8,
            num(&i["xmr"]),
            num(&i["amount"]),
            num(&i["deposit"]),
            &h32(&i["taker_spend_pub"]),
            &h32(&i["locker_view"]),
            &h32(&i["taker_enc_key"]),
            &h32(&i["maker_enc_key"]),
            &h32(&i["payout"]),
            &h32(&i["watcher"]),
        );
        assert_eq!(got, h32(&case["output"]["open_hash"]), "{}", case["name"]);
        n += 1;
    }
    assert_eq!(n, 5);
}

// ------------------------------------------------------------------ the checks of SPEC 4.6

struct Fixture {
    w: World,
    m: MakerFx,
    offer: solana_pubkey::Pubkey,
}

fn advance_offer(asset: u8, direction: u8) -> Fixture {
    let mut w = World::new();
    let mut m = w.register_maker();
    let terms = Terms { mode: 2, ..Terms::default() };
    let offer = w.live_offer(&mut m, asset, direction, &terms, PRICE);
    Fixture { w, m, offer }
}

#[test]
fn approval_is_reusable_until_revoked_by_epoch_or_operator_change() {
    let Fixture { mut w, mut m, offer } = advance_offer(ASSET_SOL, DIR_A);
    let taker = w.fund(100 * SOL);
    let ed = w.approval_ix(&m, &taker.pubkey(), ASSET_SOL, DIR_A, XMR);

    // Twice with the same signed bytes: an approval is reusable until it expires.
    for _ in 0..2 {
        let (fx, mut raw) =
            w.prepare_open_for(&m, taker.insecure_clone(), ASSET_SOL, DIR_A, XMR, Source::Offer(offer), rand16());
        raw.approval_ix = Some(0);
        raw.sysvar = Some(IX_SYSVAR);
        ok(w.send(&[ed.clone(), w.open_ix(&raw)], &[&fx.taker]));
        assert_eq!(w.swap(&fx.pda).unwrap().state, ACTIVE);
    }
    ok(w.refill(&mut m, ASSET_SOL, 0, 2));

    // Without it the ADVANCE offer refuses the lock.
    let (fx, raw) = w.prepare_open_for(&m, taker.insecure_clone(), ASSET_SOL, DIR_A, XMR, Source::Offer(offer), rand16());
    assert_err(w.send_open(&fx, &raw), "ApprovalRequired");

    // Bumping the approval epoch kills it.
    ok(w.bump_epochs(&m, true, false));
    let (fx, mut raw) = w.prepare_open_for(&m, taker.insecure_clone(), ASSET_SOL, DIR_A, XMR, Source::Offer(offer), rand16());
    raw.approval_ix = Some(0);
    raw.sysvar = Some(IX_SYSVAR);
    assert_err(w.send(&[ed.clone(), w.open_ix(&raw)], &[&fx.taker]), "ApprovalInvalid");

    // A fresh one for the new epoch works; changing the operator key kills that one too.
    let ed2 = w.approval_ix(&m, &taker.pubkey(), ASSET_SOL, DIR_A, XMR);
    ok(w.send(&[ed2.clone(), w.open_ix(&raw)], &[&fx.taker]));
    let new_operator = w.fund(10 * SOL);
    let ix = w.maker_ix(&m.owner.pubkey(), &m.pda, Enc::ix("set_operator").key(&new_operator.pubkey()).0);
    let owner = m.owner.insecure_clone();
    ok(w.send(&[ix], &[&owner]));
    let mk = w.maker(&m.pda);
    assert_eq!((mk.approval_epoch, mk.quote_epoch), (2, 1), "set_operator bumps both epochs");
    let (fx, mut raw) = w.prepare_open_for(&m, taker.insecure_clone(), ASSET_SOL, DIR_A, XMR, Source::Offer(offer), rand16());
    raw.approval_ix = Some(0);
    raw.sysvar = Some(IX_SYSVAR);
    assert_err(w.send(&[ed2, w.open_ix(&raw)], &[&fx.taker]), "ApprovalInvalid");
}

#[test]
fn approval_instruction_must_be_one_self_contained_ed25519_signature() {
    let Fixture { mut w, m, offer } = advance_offer(ASSET_SOL, DIR_A);
    let (fx, mut raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
    let good = w.approval_ix(&m, &fx.taker.pubkey(), ASSET_SOL, DIR_A, XMR);
    raw.approval_ix = Some(0);
    raw.sysvar = Some(IX_SYSVAR);

    // The index names an instruction that is not the Ed25519 program.
    let [budget, _] = compute_budget_ixs();
    assert_err(w.send(&[budget, good.clone(), w.open_ix(&raw)], &[&fx.taker]), "SignatureInstructionInvalid");
    // The index names the lock itself, or nothing.
    let mut r = raw.clone();
    r.approval_ix = Some(1);
    assert_err(w.send(&[good.clone(), w.open_ix(&r)], &[&fx.taker]), "SignatureInstructionInvalid");
    r.approval_ix = Some(9);
    assert_err(w.send(&[good.clone(), w.open_ix(&r)], &[&fx.taker]), "SignatureInstructionInvalid");
    // The sysvar account is absent, or is some other account.
    let mut r = raw.clone();
    r.sysvar = None;
    assert_err(w.send(&[good.clone(), w.open_ix(&r)], &[&fx.taker]), "SignatureInstructionInvalid");
    r.sysvar = Some(w.config);
    assert_err(w.send(&[good.clone(), w.open_ix(&r)], &[&fx.taker]), "SignatureInstructionInvalid");

    // Two signatures in one instruction (both valid): refused, "exactly one".
    let msg = good.data[112..].to_vec();
    let sig = m.operator.sign_message(&msg);
    let mut two = vec![2u8, 0];
    let body = 2 + 14 * 2;
    for _ in 0..2 {
        for v in [(body + 32) as u16, 0xffff, body as u16, 0xffff, (body + 96) as u16, msg.len() as u16, 0xffff] {
            two.extend_from_slice(&v.to_le_bytes());
        }
    }
    two.extend_from_slice(&m.operator.pubkey().to_bytes());
    two.extend_from_slice(sig.as_ref());
    two.extend_from_slice(&msg);
    let two_ix = Instruction { program_id: ED25519, accounts: vec![], data: two };
    ok(w.send(&[two_ix.clone()], &[&fx.taker])); // the precompile itself is happy
    assert_err(w.send(&[two_ix, w.open_ix(&raw)], &[&fx.taker]), "SignatureInstructionInvalid");

    // The forgery this rule exists for. Instruction 0 holds a genuine signature by the
    // *attacker's* key over the attacker's message. Instruction 1 is an Ed25519 instruction
    // whose offsets point into instruction 0 (so the precompile verifies the attacker's
    // signature), while its own bytes carry the operator's key and an approval nobody signed.
    let attacker = Keypair::new();
    let carrier = ed25519_ix(&attacker, &msg);
    let mut forged = vec![1u8, 0];
    for v in [48u16, 0, 16, 0, 112, msg.len() as u16, 0] {
        forged.extend_from_slice(&v.to_le_bytes());
    }
    forged.extend_from_slice(&m.operator.pubkey().to_bytes());
    forged.extend_from_slice(&[0u8; 64]);
    forged.extend_from_slice(&msg);
    let forged_ix = Instruction { program_id: ED25519, accounts: vec![], data: forged };
    ok(w.send(&[carrier.clone(), forged_ix.clone()], &[&fx.taker])); // passes signature verification
    let mut r = raw.clone();
    r.approval_ix = Some(1);
    assert_err(w.send(&[carrier, forged_ix, w.open_ix(&r)], &[&fx.taker]), "SignatureInstructionInvalid");

    // And the honest transaction locks.
    ok(w.send(&[good, w.open_ix(&raw)], &[&fx.taker]));
    assert_eq!(w.swap(&fx.pda).unwrap().mode, 2);
}

#[test]
fn approval_never_overrides_price_terms_size_or_capacity() {
    let Fixture { mut w, m, offer } = advance_offer(ASSET_SOL, DIR_A);
    let send = |w: &mut World, change: &dyn Fn(&mut OpenRaw)| {
        let (fx, mut raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
        raw.approval_ix = Some(0);
        raw.sysvar = Some(IX_SYSVAR);
        change(&mut raw);
        let ed = w.approval_ix(&m, &fx.taker.pubkey(), 0xff, 0xff, u64::MAX);
        w.send(&[ed, w.open_ix(&raw)], &[&fx.taker])
    };
    assert_err(send(&mut w, &|r| r.limit = PRICE - 1), "PriceMoved");
    assert_err(send(&mut w, &|r| r.terms_hash = [9; 32]), "TermsChanged");
    assert_err(send(&mut w, &|r| r.xmr = 1_001 * XMR), "AmountOutOfRange");
    assert_err(send(&mut w, &|r| r.min_seq = 1_000), "SeqTooOld");
    ok(w.refresh(&m, &[(ASSET_SOL, DIR_A, true, [PRICE, 0, 0], XMR / 2)]));
    assert_err(send(&mut w, &|_| {}), "CapacityExceeded");
    ok(w.refresh(&m, &[(ASSET_SOL, DIR_A, true, [PRICE, 0, 0], XMR)]));
    ok(send(&mut w, &|_| {}));
    assert_eq!(w.offer(&offer).capacity_xmr, 0);
}
