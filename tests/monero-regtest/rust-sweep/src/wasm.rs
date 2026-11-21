//! Browser bindings: the daemon transport is `fetch`, everything else is the shared core.
//! The node must send CORS headers (monerod: `--rpc-access-control-origins`), or sit behind a
//! same-origin reverse proxy.
use core::future::Future;
use monero_daemon_rpc::{HttpTransport, MoneroDaemon};
use monero_wallet::interface::InterfaceError;
use send_wrapper::SendWrapper;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
  // The global fetch, present on both Window and WorkerGlobalScope.
  #[wasm_bindgen(js_name = fetch)]
  fn fetch_request(input: &web_sys::Request) -> js_sys::Promise;
}

#[derive(Clone)]
struct FetchTransport {
  base: String,
}

async fn fetch_post(url: String, body: Vec<u8>, limit: Option<usize>) -> Result<Vec<u8>, String> {
  let js = |e: JsValue| format!("{e:?}");
  let init = web_sys::RequestInit::new();
  init.set_method("POST");
  init.set_mode(web_sys::RequestMode::Cors);
  // No Content-Type header: monerod does not need one, and without it the POST is a CORS
  // "simple request" (no preflight round trip).
  init.set_body(&js_sys::Uint8Array::from(body.as_slice()));
  let req = web_sys::Request::new_with_str_and_init(&url, &init).map_err(js)?;
  let resp: web_sys::Response = JsFuture::from(fetch_request(&req)).await.map_err(js)?.dyn_into().map_err(js)?;
  if !resp.ok() {
    return Err(format!("HTTP {} from {url}", resp.status()));
  }
  let buf = JsFuture::from(resp.array_buffer().map_err(js)?).await.map_err(js)?;
  let bytes = js_sys::Uint8Array::new(&buf).to_vec();
  if limit.is_some_and(|l| bytes.len() > l) {
    return Err("response exceeded size limit".into());
  }
  Ok(bytes)
}

impl HttpTransport for FetchTransport {
  fn post(&self, route: &str, body: Vec<u8>, limit: Option<usize>) -> impl Send + Future<Output = Result<Vec<u8>, InterfaceError>> {
    let url = format!("{}/{}", self.base.trim_end_matches('/'), route.trim_start_matches('/'));
    // JS promises are not Send; wasm32 in a tab or worker is single-threaded, so SendWrapper
    // (which panics only if polled from another thread) is sound here.
    SendWrapper::new(async move { fetch_post(url, body, limit).await.map_err(InterfaceError::InterfaceError) })
  }
}

/// Resolves to a JSON string: { jointAddress, txid, amount, fee, inputs, published, txHex }.
#[wasm_bindgen(js_name = sweepJoint)]
pub async fn sweep_joint_js(
  daemon_url: String,
  network: String,
  spend_key: String,
  view_key: String,
  lock_height: u32,
  destination: String,
  publish: bool,
) -> Result<String, JsError> {
  let err = |e: String| JsError::new(&e);
  let daemon = MoneroDaemon::new(FetchTransport { base: daemon_url }).await.map_err(|e| err(format!("connect: {e:?}")))?;
  let p = crate::SweepParams {
    network: crate::parse_network(&network).map_err(err)?,
    spend_key: crate::parse_key(&spend_key).map_err(err)?,
    view_key: crate::parse_key(&view_key).map_err(err)?,
    lock_height: lock_height as usize,
    destination,
    publish,
  };
  crate::sweep_joint(&daemon, p).await.map(|o| o.to_json()).map_err(err)
}
