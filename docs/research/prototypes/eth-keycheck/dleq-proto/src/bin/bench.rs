use dleq_proto::*;
use std::time::Instant;

fn compress(u: &[u8]) -> [u8; 33] {
  let mut c = [0u8; 33];
  c[0] = 2 + (u[64] & 1);
  c[1..].copy_from_slice(&u[1..33]);
  c
}

fn main() {
  let runs = 20u32;

  // ---------- serai dleq (CompromiseLinear) ----------
  let fixed = serai::prove([1; 32], b"fixed test vector key seed", b"ctx");
  println!("serai vector: s=0x{} addr=0x{} secp=0x{} ed=0x{}",
    hex::encode(fixed.secret_be), hex::encode(eth_address(&fixed.secp_pub)), hex::encode(&fixed.secp_pub), hex::encode(fixed.ed_pub));
  assert!(fixed.secret_be[0] < 0x10, "secret must be < 2^252");
  // independent check that the ed25519 point is s*B using a different library (curve25519-dalek-ng)
  {
    use curve25519_dalek_ng::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
    let mut le = fixed.secret_be; le.reverse();
    assert_eq!((&Scalar::from_canonical_bytes(le).unwrap() * &ED25519_BASEPOINT_POINT).compress().to_bytes(), fixed.ed_pub);
  }
  let mut proofs = vec![];
  let t = Instant::now();
  for i in 0..runs { proofs.push(serai::prove([i as u8; 32], &[i as u8; 32], b"ctx")); }
  let prove = t.elapsed() / runs;
  let t = Instant::now();
  for p in &proofs {
    let (a, b) = serai::verify([9; 32], &p.proof, b"ctx").unwrap();
    assert!(a == p.secp_pub && b == p.ed_pub);
  }
  let verify = t.elapsed() / runs;
  println!("serai dleq 0.4.1 CompromiseLinear: proof {} bytes, prove {:?}, verify {:?}", proofs[0].proof.len(), prove, verify);
  // negative tests
  assert!(serai::verify([9; 32], &proofs[0].proof, b"other swap").is_none(), "context must bind");
  let mut bad = proofs[0].proof.clone(); bad[1000] ^= 1;
  assert!(serai::verify([9; 32], &bad, b"ctx").is_none(), "tampered proof must fail");
  let mut long = proofs[0].proof.clone(); long.push(0);
  assert!(serai::verify([9; 32], &long, b"ctx").is_none(), "trailing bytes must fail");
  println!("serai negative tests ok (wrong context, bit flip, trailing byte)");

  // ---------- sigma_fun ----------
  let t = Instant::now();
  let sys = sigma::system();
  println!("sigma_fun setup (powers of two): {:?}", t.elapsed());
  let mut proofs = vec![];
  let t = Instant::now();
  for i in 0..runs {
    let mut s = [i as u8 + 1; 32]; s[31] &= 0x0f;
    proofs.push(sigma::prove(&sys, [i as u8; 32], s));
  }
  let prove = t.elapsed() / runs;
  let t = Instant::now();
  for p in &proofs { assert!(sigma::verify(&sys, &p.proof, compress(&p.secp_pub), p.ed_pub)); }
  let verify = t.elapsed() / runs;
  println!("sigma_fun 0.9.0 CrossCurveDLEQ: proof {} bytes (bincode), prove {:?}, verify {:?}", proofs[0].proof.len(), prove, verify);
  let mut bad = proofs[0].proof.clone(); bad[1000] ^= 1;
  assert!(!sigma::verify(&sys, &bad, compress(&proofs[0].secp_pub), proofs[0].ed_pub));
  assert!(!sigma::verify(&sys, &proofs[0].proof, compress(&proofs[1].secp_pub), proofs[0].ed_pub));
  println!("sigma_fun negative tests ok");
  let p = &proofs[3];
  println!("sigma vector: s=0x{} addr=0x{}", hex::encode(p.secret_be), hex::encode(eth_address(&p.secp_pub)));
}
