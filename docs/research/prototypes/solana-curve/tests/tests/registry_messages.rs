//! Q4: listing accounts by discriminator and three ways to post a message.
mod common;
use common::*;
use solana_signer::Signer;

#[test]
fn list_makers_by_discriminator() {
    let mut svm = setup();
    let mut owners = vec![];
    for i in 0..3u8 {
        let owner = funded(&mut svm, SOL);
        let ix = ix(
            "register_maker",
            &[&[i; 32]],
            vec![w(owner.pubkey(), true), w(maker_pda(&owner.pubkey()), false), r(SYSTEM, false)],
        );
        send(&mut svm, &[ix], &[&owner]).unwrap();
        owners.push(owner.pubkey());
    }
    // noise: other account types owned by the same program
    for _ in 0..4 {
        let p = funded(&mut svm, SOL);
        let (_, point) = key_share();
        send(&mut svm, &[commit_ix("commit", &p.pubkey(), &point)], &[&p]).unwrap();
    }

    // == getProgramAccounts(programId, filters: [{memcmp: {offset: 0, bytes: disc}}])
    let disc = account_disc("Maker");
    let all = svm.get_program_accounts(&PROGRAM_ID);
    assert_eq!(all.len(), 7);
    let makers: Vec<_> = all.into_iter().filter(|(_, a)| a.data.len() >= 8 && a.data[..8] == disc).collect();
    assert_eq!(makers.len(), 3);
    for (addr, acc) in &makers {
        let owner = solana_pubkey::Pubkey::new_from_array(acc.data[8..40].try_into().unwrap());
        assert!(owners.contains(&owner));
        assert_eq!(*addr, maker_pda(&owner));
        assert_eq!(acc.data.len(), 8 + 32 + 32 + 4 + 8 + 1);
    }
    println!("Maker discriminator bytes: {:?}", disc);
}

#[test]
fn message_posting_costs() {
    let mut svm = setup();
    let sender = funded(&mut svm, SOL);
    let to = [7u8; 32];
    for len in [64usize, 256, 700] {
        let payload: Vec<u8> = (0..len).map(|i| i as u8).collect();
        let enc = borsh_vec(&payload);

        let noop = send(&mut svm, &[ix("post_message_noop", &[&to, &enc], vec![r(sender.pubkey(), true)])], &[&sender]).unwrap();
        let log = send(&mut svm, &[ix("post_message_log", &[&to, &enc], vec![r(sender.pubkey(), true)])], &[&sender]).unwrap();
        let cpi = send(
            &mut svm,
            &[ix(
                "post_message_cpi",
                &[&to, &enc],
                vec![r(sender.pubkey(), true), r(event_authority(), false), r(PROGRAM_ID, false)],
            )],
            &[&sender],
        )
        .unwrap();

        // (b) the event is in the logs
        let ev = logged_events(&log, "Message");
        assert_eq!(ev.len(), 1);
        assert_eq!(&ev[0][64 + 4..], &payload[..]);
        // (c) the event is the data of an inner instruction to our own program
        assert!(logged_events(&cpi, "Message").is_empty());
        let inner = &cpi.inner_instructions[0][0].instruction.data;
        assert_eq!(inner[..8], EVENT_IX_TAG_LE);
        assert_eq!(inner[8..16], event_disc("Message"));
        assert_eq!(&inner[16 + 64 + 4..], &payload[..]);

        println!(
            "payload {len:>3} B: ix-data only {:>5} CU | emit! {:>5} CU | emit_cpi! {:>5} CU",
            noop.compute_units_consumed, log.compute_units_consumed, cpi.compute_units_consumed
        );
    }
}
