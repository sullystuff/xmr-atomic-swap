//! Native CLI: xmr-joint-sweep <daemon-url> <network> <spend-key-hex> <view-key-hex> <lock-height> <destination> [--dry-run]
#[cfg(not(target_arch = "wasm32"))]
#[tokio::main(flavor = "current_thread")]
async fn main() {
  use monero_simple_request_rpc::SimpleRequestTransport;
  use xmr_joint_sweep::*;
  let a: Vec<String> = std::env::args().collect();
  if a.len() < 7 {
    eprintln!("usage: {} <daemon-url> <network> <spend-key> <view-key> <lock-height> <destination> [--dry-run]", a[0]);
    std::process::exit(2);
  }
  let run = async {
    let daemon = SimpleRequestTransport::new(a[1].clone()).await.map_err(|e| format!("connect: {e:?}"))?;
    let p = SweepParams {
      network: parse_network(&a[2])?,
      spend_key: parse_key(&a[3])?,
      view_key: parse_key(&a[4])?,
      lock_height: a[5].parse().map_err(|_| "bad height".to_string())?,
      destination: a[6].clone(),
      publish: a.get(7).map(String::as_str) != Some("--dry-run"),
    };
    sweep_joint(&daemon, p).await
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
