//! Native sweep CLI, used by the regtest harness and available to operators as an escape hatch.
//!
//! ```text
//! xmr-joint-sweep <daemon-url> <network> <spend-key-hex> <view-key-hex> <lock-height>
//!                 <lock-txid-hex> <output-index> <destination> <max-fee-piconero> [--dry-run]
//! ```
//!
//! Prints the outcome as one line of JSON on success; prints `error: …` and exits 1 otherwise.
//! Keys on a command line are visible to other local users: this binary is for tests and for
//! recovery on a machine the operator controls.

#[cfg(not(target_arch = "wasm32"))]
#[tokio::main(flavor = "current_thread")]
async fn main() {
  use monero_simple_request_rpc::SimpleRequestTransport;
  use swap_core::{address::Network, sweep::*};

  let a: Vec<String> = std::env::args().collect();
  if a.len() < 10 {
    eprintln!(
      "usage: {} <daemon-url> <network> <spend-key> <view-key> <lock-height> <lock-txid> <output-index> <destination> <max-fee> [--dry-run]",
      a[0]
    );
    std::process::exit(2);
  }
  let run = async {
    let daemon = SimpleRequestTransport::new(a[1].clone()).await.map_err(|e| format!("connect: {e:?}"))?;
    let p = SweepParams {
      network: Network::parse(&a[2]).map_err(|_| format!("unknown network {}", a[2]))?,
      spend_key: parse_key(&a[3]).map_err(|e| e.to_string())?,
      view_key: parse_key(&a[4]).map_err(|e| e.to_string())?,
      lock_height: a[5].parse().map_err(|_| "bad lock height".to_string())?,
      lock_txid: parse_key(&a[6]).map_err(|e| e.to_string())?,
      output_index: a[7].parse().map_err(|_| "bad output index".to_string())?,
      destination: a[8].clone(),
      max_fee: a[9].parse().map_err(|_| "bad max fee".to_string())?,
      publish: a.get(10).map(String::as_str) != Some("--dry-run"),
    };
    sweep_joint(&daemon, p).await.map_err(|e| e.to_string())
  };
  match run.await {
    Ok(o) => println!("{}", o.to_json()),
    Err(e) => {
      eprintln!("error: {e}");
      std::process::exit(1)
    }
  }
}

#[cfg(target_arch = "wasm32")]
fn main() {}
