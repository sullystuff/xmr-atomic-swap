//! SPEC 4.6 spike (WP2's first task): an advance approval from `sol_signed.json`, carried by an
//! Ed25519 precompile instruction, verified by the runtime and read by the program through the
//! instructions sysvar, under LiteSVM 0.16.0.
use crate::common::*;
use solana_instruction::Instruction;

fn spike_ix(operator: &[u8], cluster: &[u8], maker: &[u8], taker: &[u8], index: u8, program_id: &[u8]) -> Instruction {
    let mut payload = Vec::new();
    payload.extend_from_slice(operator);
    payload.extend_from_slice(cluster);
    payload.extend_from_slice(maker);
    payload.extend_from_slice(taker);
    payload.push(index);
    payload.extend_from_slice(program_id);
    let mut data = ix_disc("post_message").to_vec();
    data.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    data.extend_from_slice(&payload);
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![meta(solana_pubkey::Pubkey::new_unique(), true, false), meta(IX_SYSVAR, false, false), meta(PROGRAM_ID, false, false)],
        data,
    }
}

#[test]
fn spike_vector_case_verifies() {
    let v = vectors("sol_signed");
    let mut svm = base_svm();
    let payer = funded(&mut svm, 10_000_000_000);
    let case = v["cases"].as_array().unwrap().iter().find(|c| c["name"] == "at-not-before").unwrap();
    let a = &case["input"]["approval"];
    let ed = Instruction { program_id: ED25519, accounts: vec![], data: h(&case["output"]["ed25519_instruction_data"]) };
    let mut ix = spike_ix(&h(&v["operator_pub"]), &h(&a["cluster_tag"]), &h(&a["maker"]), &h(&a["taker"]), 0, &h(&a["program_id"]));
    ix.accounts[0] = meta(solana_signer::Signer::pubkey(&payer), true, false);
    let res = send(&mut svm, &[ed.clone(), ix.clone()], &[&payer]).expect("precompile + sysvar read");
    println!("{}", res.pretty_logs());
    assert!(res.logs.iter().any(|l| l.contains("spike approval 1 0 5000000000000 1800000000 1800086400 7 81985529216486895")));

    // Wrong operator: the program refuses (ApprovalInvalid = 6020).
    let mut bad = spike_ix(&[9u8; 32], &h(&a["cluster_tag"]), &h(&a["maker"]), &h(&a["taker"]), 0, &h(&a["program_id"]));
    bad.accounts[0] = ix.accounts[0].clone();
    let err = send(&mut svm, &[ed.clone(), bad], &[&payer]).unwrap_err();
    assert!(format!("{:?}", err.err).contains("Custom(6020)"), "{:?}", err.err);

    // Index pointing at a non-Ed25519 instruction: SignatureInstructionInvalid = 6025.
    let mut wrong_index = spike_ix(&h(&v["operator_pub"]), &h(&a["cluster_tag"]), &h(&a["maker"]), &h(&a["taker"]), 1, &h(&a["program_id"]));
    wrong_index.accounts[0] = ix.accounts[0].clone();
    let err = send(&mut svm, &[ed, wrong_index], &[&payer]).unwrap_err();
    assert!(format!("{:?}", err.err).contains("Custom(6025)"), "{:?}", err.err);

    // A tampered signature never reaches the program: the precompile fails the transaction.
    let t = v["cases"].as_array().unwrap().iter().find(|c| c["name"] == "tampered-signature").unwrap();
    let mut data = h(&case["output"]["ed25519_instruction_data"]);
    data[48..112].copy_from_slice(&h(&t["input"]["signature"]));
    let ed_bad = Instruction { program_id: ED25519, accounts: vec![], data };
    let err = send(&mut svm, &[ed_bad, ix], &[&payer]).unwrap_err();
    println!("tampered: {:?}", err.err);
    assert!(!format!("{:?}", err.err).contains("Custom(60"));
}
