//! Write or check the test vectors of SPEC 2.12.
//!
//! ```text
//! cargo run -p swap-core --bin gen-vectors -- interfaces/vectors           write every file
//! cargo run -p swap-core --bin gen-vectors -- --check interfaces/vectors   regenerate in memory; fail on any difference
//! ```
#[cfg(not(target_arch = "wasm32"))]
fn main() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let (check, dir) = match args.as_slice() {
    [dir] if dir != "--check" => (false, dir),
    [flag, dir] if flag == "--check" => (true, dir),
    _ => {
      eprintln!("usage: gen-vectors [--check] <directory>");
      std::process::exit(2);
    }
  };
  let dir = std::path::Path::new(dir);
  if check {
    let problems = swap_core::vectors::check_dir(dir);
    if !problems.is_empty() {
      eprintln!("gen-vectors --check: {} differs from what swap-core generates:", dir.display());
      for p in &problems {
        eprintln!("  {p}");
      }
      eprintln!("Regenerate with: cargo run -p swap-core --bin gen-vectors -- {}", dir.display());
      std::process::exit(1);
    }
    println!("gen-vectors --check: {} files in {} are reproducible", swap_core::vectors::generate().len(), dir.display());
  } else {
    match swap_core::vectors::write_dir(dir) {
      Ok(n) => println!("gen-vectors: wrote {n} files to {}", dir.display()),
      Err(e) => {
        eprintln!("gen-vectors: {e}");
        std::process::exit(1);
      }
    }
  }
}

#[cfg(target_arch = "wasm32")]
fn main() {}
