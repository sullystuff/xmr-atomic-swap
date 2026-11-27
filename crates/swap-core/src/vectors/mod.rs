//! Test vectors (SPEC 2.12). `generate()` builds every file of `interfaces/vectors/`
//! deterministically from fixed seeds; `gen-vectors` writes them or, with `--check`, regenerates
//! in memory and fails on any difference.
//!
//! Format of a suite:
//!
//! ```json
//! { "format": "xmrswap-vectors/1", "suite": "pok", "cases": [
//!   { "name": "valid-1", "valid": true,  "input": { … }, "output": { … } },
//!   { "name": "wrong-ctx", "valid": false, "input": { … }, "error": "PokInvalid" } ] }
//! ```
//!
//! Binary values are lowercase hex; amounts and other integers above 2^53 are decimal strings;
//! times are numbers (Unix seconds).

use serde_json::{json, Map, Value};

use crate::primitives::{clamp252, sha256, sha512, wide};

mod crypto;
mod machine;
mod signed;

pub const FORMAT: &str = "xmrswap-vectors/1";

/// One generated file: path relative to the vectors directory, and its bytes.
pub struct VectorFile {
  pub path: String,
  pub bytes: Vec<u8>,
}

/// 32 deterministic bytes for a label.
pub(crate) fn fixed(tag: &str) -> [u8; 32] {
  sha256(&[b"xmrswap-vectors/1/", tag.as_bytes()])
}
/// A deterministic spend share (`0 < s < 2^252`).
pub(crate) fn share(tag: &str) -> [u8; 32] {
  clamp252(fixed(tag))
}
/// A deterministic canonical nonzero scalar.
pub(crate) fn scalar(tag: &str) -> [u8; 32] {
  wide(&sha512(&[b"xmrswap-vectors/1/", tag.as_bytes()])).to_bytes()
}
pub(crate) fn fixed_n<const N: usize>(tag: &str) -> [u8; N] {
  let mut out = [0u8; N];
  let mut i = 0u32;
  let mut filled = 0;
  while filled < N {
    let block = sha256(&[b"xmrswap-vectors/1/", tag.as_bytes(), &i.to_le_bytes()]);
    let n = (N - filled).min(32);
    out[filled..filled + n].copy_from_slice(&block[..n]);
    filled += n;
    i += 1;
  }
  out
}
pub(crate) fn h(b: impl AsRef<[u8]>) -> String {
  hex::encode(b)
}
/// `0x`-prefixed hex, for EVM addresses and bytes32 in EIP-712 JSON.
pub(crate) fn h0x(b: impl AsRef<[u8]>) -> String {
  format!("0x{}", hex::encode(b))
}
/// A decimal string.
pub(crate) fn d(v: impl ToString) -> String {
  v.to_string()
}

pub(crate) fn ok_case(name: &str, input: Value, output: Value) -> Value {
  json!({ "name": name, "valid": true, "input": input, "output": output })
}
pub(crate) fn err_case(name: &str, input: Value, error: &str) -> Value {
  json!({ "name": name, "valid": false, "input": input, "error": error })
}

/// Serialise a suite. Keys are sorted (serde_json's default map), so the bytes are stable.
pub(crate) fn suite(name: &str, cases: Vec<Value>, extra: Vec<(&str, Value)>) -> VectorFile {
  let mut bytes = serde_json::to_vec_pretty(&suite_value(name, cases, extra)).expect("vectors serialise");
  bytes.push(b'\n');
  VectorFile { path: format!("{name}.json"), bytes }
}

fn suite_value(name: &str, cases: Vec<Value>, extra: Vec<(&str, Value)>) -> Value {
  let mut m = Map::new();
  m.insert("format".into(), json!(FORMAT));
  m.insert("suite".into(), json!(name));
  for (k, v) in extra {
    m.insert(k.into(), v);
  }
  m.insert("cases".into(), Value::Array(cases));
  Value::Object(m)
}

/// As [`suite`] for large suites: every element of a top-level array goes on one line, so the
/// file stays a few megabytes and still diffs row by row.
pub(crate) fn suite_lines(name: &str, cases: Vec<Value>, extra: Vec<(&str, Value)>) -> VectorFile {
  let Value::Object(m) = suite_value(name, cases, extra) else { unreachable!() };
  let mut out = String::from("{\n");
  let last = m.len() - 1;
  for (i, (key, value)) in m.iter().enumerate() {
    out.push_str(&format!("{}: ", serde_json::to_string(key).unwrap()));
    match value {
      Value::Array(items) if !items.is_empty() => {
        out.push_str("[\n");
        for (j, item) in items.iter().enumerate() {
          out.push_str(&serde_json::to_string(item).unwrap());
          out.push_str(if j + 1 == items.len() { "\n" } else { ",\n" });
        }
        out.push(']');
      }
      other => out.push_str(&serde_json::to_string(other).unwrap()),
    }
    out.push_str(if i == last { "\n" } else { ",\n" });
  }
  out.push_str("}\n");
  VectorFile { path: format!("{name}.json"), bytes: out.into_bytes() }
}

/// The recorded regtest fixture (SPEC 2.12, `monero_tx.json`): raw transactions and blocks
/// recorded once from the harness by `tests/monero-regtest/record-vectors.mjs`. It cannot be
/// regenerated from a seed, so it is embedded and written out verbatim.
pub const MONERO_TX_FIXTURE: &str = include_str!("../../fixtures/monero_tx.json");

/// Every vector file, in a stable order.
pub fn generate() -> Vec<VectorFile> {
  let mut files = Vec::new();
  files.push(crypto::keys());
  files.push(crypto::points());
  files.push(crypto::pok());
  files.push(crypto::joint_address());
  files.push(crypto::twin());
  files.extend(crypto::dleq());
  files.push(crypto::merkle());
  files.push(signed::notice());
  files.push(signed::envelope());
  files.push(signed::sol_signed());
  files.push(signed::eip712());
  files.push(signed::wallet_seed());
  files.push(signed::watch_request());
  files.push(machine::terms());
  files.push(machine::amounts());
  files.push(machine::deadlines());
  files.push(machine::transitions());
  files.push(VectorFile { path: "monero_tx.json".into(), bytes: MONERO_TX_FIXTURE.as_bytes().to_vec() });
  files
}

/// Compare `generate()` with a directory. Returns one line per difference; empty = identical.
pub fn check_dir(dir: &std::path::Path) -> Vec<String> {
  let files = generate();
  let mut problems = Vec::new();
  let mut expected = std::collections::BTreeSet::new();
  for f in &files {
    expected.insert(f.path.clone());
    match std::fs::read(dir.join(&f.path)) {
      Ok(on_disk) if on_disk == f.bytes => {}
      Ok(on_disk) => problems.push(format!("{}: differs ({} bytes on disk, {} generated)", f.path, on_disk.len(), f.bytes.len())),
      Err(e) => problems.push(format!("{}: {e}", f.path)),
    }
  }
  // Nothing else may live next to the vectors: a stale file would be consumed by somebody.
  for sub in ["", "dleq"] {
    let Ok(entries) = std::fs::read_dir(dir.join(sub)) else { continue };
    for e in entries.flatten() {
      if e.path().is_dir() {
        continue;
      }
      let rel = if sub.is_empty() { e.file_name().to_string_lossy().into_owned() } else { format!("{sub}/{}", e.file_name().to_string_lossy()) };
      if !expected.contains(&rel) {
        problems.push(format!("{rel}: not a generated vector file"));
      }
    }
  }
  problems
}

/// Write every file under `dir`.
pub fn write_dir(dir: &std::path::Path) -> std::io::Result<usize> {
  let files = generate();
  for f in &files {
    let path = dir.join(&f.path);
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, &f.bytes)?;
  }
  Ok(files.len())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn generation_is_deterministic() {
    let a = generate();
    let b = generate();
    assert_eq!(a.len(), b.len());
    for (x, y) in a.iter().zip(&b) {
      assert_eq!(x.path, y.path);
      assert!(x.bytes == y.bytes, "{} differs between two runs", x.path);
    }
  }

  #[test]
  fn every_suite_of_the_specification_is_present_and_well_formed() {
    let files = generate();
    let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    for required in [
      "keys.json", "points.json", "pok.json", "joint_address.json", "twin.json", "dleq.json", "merkle.json", "notice.json",
      "envelope.json", "sol_signed.json", "eip712.json", "terms.json", "amounts.json", "deadlines.json", "transitions.json",
      "monero_tx.json",
    ] {
      assert!(names.contains(&required), "{required} missing");
    }
    assert!(names.iter().filter(|n| n.starts_with("dleq/") && n.ends_with(".bin")).count() >= 6);
    for f in files.iter().filter(|f| f.path.ends_with(".json")) {
      let v: Value = serde_json::from_slice(&f.bytes).unwrap_or_else(|e| panic!("{}: {e}", f.path));
      assert_eq!(v["format"], FORMAT, "{}", f.path);
      assert_eq!(v["suite"].as_str().unwrap(), f.path.trim_end_matches(".json"), "{}", f.path);
      for case in v["cases"].as_array().unwrap_or_else(|| panic!("{}: no cases", f.path)) {
        assert!(case["name"].is_string(), "{}: unnamed case", f.path);
        let valid = case["valid"].as_bool().unwrap_or_else(|| panic!("{}: {} has no `valid`", f.path, case["name"]));
        assert_eq!(case.get("error").is_some(), !valid, "{}: {}", f.path, case["name"]);
      }
      // Names are unique within a suite.
      let mut seen = std::collections::BTreeSet::new();
      for case in v["cases"].as_array().unwrap() {
        assert!(seen.insert(case["name"].as_str().unwrap().to_string()), "{}: duplicate case {}", f.path, case["name"]);
      }
    }
  }
}
