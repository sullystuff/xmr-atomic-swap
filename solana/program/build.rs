//! `anchor idl build -o target/idl/xmr_swap.json` (the acceptance command of SPEC 10.3) does not
//! create the output directory, and on a clean checkout nothing else has. Create it here, so the
//! `cargo build-sbf` that precedes it leaves the directory in place.
fn main() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/idl");
    let _ = std::fs::create_dir_all(dir);
    println!("cargo:rerun-if-changed=build.rs");
}
