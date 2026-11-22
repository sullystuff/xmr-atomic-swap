//! `svm-rpc`: a loopback-only Solana JSON-RPC subset over one in-memory LiteSVM 0.16.0
//! (docs/SPEC.md section 9.2). A test fixture, not a validator: no ledger, no consensus, no
//! networking beyond 127.0.0.1, and all state dies with the process.

pub mod facade;
pub mod token;

pub use facade::Facade;
use {
    sha2::{Digest, Sha256},
    std::{io::Read, net::Ipv4Addr},
    tiny_http::{Header, Method, Response, Server},
};

/// The Agave runtime LiteSVM 0.16.0 resolves to.
pub const SOLANA_CORE_VERSION: &str = "4.2.2";
/// The only address this tool ever binds.
pub const BIND_HOST: &str = "127.0.0.1";
const MAX_BODY: u64 = 64 << 20;

/// A fixed fake genesis hash, so nothing configured for a real cluster accepts this endpoint.
pub fn genesis_hash() -> String {
    bs58::encode(Sha256::digest(b"xmrswap svm-rpc: in-memory LiteSVM, not a cluster")).into_string()
}

/// Refuses every bind address except 127.0.0.1.
pub fn check_host(host: &str) -> Result<(), String> {
    if host == BIND_HOST {
        Ok(())
    } else {
        Err(format!("refusing to bind `{host}`: svm-rpc listens on {BIND_HOST} only"))
    }
}

/// Binds 127.0.0.1 on `port` (0 picks a free one) and returns the server and its port.
pub fn bind(port: u16) -> Result<(Server, u16), String> {
    let server = Server::http((Ipv4Addr::LOCALHOST, port)).map_err(|e| format!("cannot bind {BIND_HOST}:{port}: {e}"))?;
    let bound = server.server_addr().to_ip().ok_or("no socket address")?;
    assert!(bound.ip().is_loopback(), "svm-rpc bound a non-loopback address");
    Ok((server, bound.port()))
}

fn host_of(authority: &str) -> &str {
    let a = authority.trim();
    match a.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => a.rsplit_once(':').map_or(a, |(h, port)| if port.bytes().all(|b| b.is_ascii_digit()) { h } else { a }),
    }
}

fn is_loopback_name(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// A page served from anywhere but this machine must not be able to drive the fixture: the
/// `Host` header has to name loopback (DNS rebinding) and so does `Origin` when a browser sends it.
fn loopback_origin(origin: &str) -> bool {
    origin.split_once("://").is_some_and(|(_, rest)| is_loopback_name(host_of(rest.split('/').next().unwrap_or(""))))
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

fn find_header(request: &tiny_http::Request, name: &'static str) -> Option<String> {
    request.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string())
}

/// Serves requests one at a time, forever. Every request sees the state the previous one left.
pub fn serve(server: Server, mut facade: Facade) {
    for mut request in server.incoming_requests() {
        let (host, origin) = (find_header(&request, "Host"), find_header(&request, "Origin"));
        let host_ok = host.as_deref().is_some_and(|h| is_loopback_name(host_of(h)));
        let origin_ok = origin.as_deref().is_none_or(loopback_origin);

        let (status, content_type, body) = if !host_ok || !origin_ok {
            (403, "text/plain", "svm-rpc serves loopback clients only".to_string())
        } else {
            match request.method() {
                Method::Options => (204, "text/plain", String::new()),
                Method::Get => (200, "text/plain", "ok".to_string()),
                Method::Post => {
                    let mut buf = Vec::new();
                    match request.as_reader().take(MAX_BODY + 1).read_to_end(&mut buf) {
                        Ok(n) if n as u64 <= MAX_BODY => (200, "application/json", facade.handle_body(&buf)),
                        Ok(_) => (413, "text/plain", "request body too large".to_string()),
                        Err(e) => (400, "text/plain", format!("cannot read request body: {e}")),
                    }
                }
                _ => (405, "text/plain", "use POST".to_string()),
            }
        };

        let mut response = Response::from_string(body).with_status_code(status).with_header(header("Content-Type", content_type));
        if let Some(origin) = origin.filter(|_| origin_ok) {
            response = response
                .with_header(header("Access-Control-Allow-Origin", &origin))
                .with_header(header("Vary", "Origin"))
                .with_header(header("Access-Control-Allow-Methods", "POST, GET, OPTIONS"))
                .with_header(header("Access-Control-Allow-Headers", "content-type, solana-client, authorization"))
                .with_header(header("Access-Control-Max-Age", "86400"));
        }
        let _ = request.respond(response);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_is_bound() {
        assert!(check_host("127.0.0.1").is_ok());
        for host in ["0.0.0.0", "::", "::1", "localhost", "192.168.1.10", "127.0.0.2", ""] {
            assert!(check_host(host).is_err(), "{host}");
        }
    }

    #[test]
    fn host_and_origin_rules() {
        assert_eq!(host_of("127.0.0.1:8899"), "127.0.0.1");
        assert_eq!(host_of("localhost"), "localhost");
        assert_eq!(host_of("[::1]:8899"), "::1");
        assert!(loopback_origin("http://127.0.0.1:5173"));
        assert!(loopback_origin("http://localhost:5173"));
        assert!(!loopback_origin("https://evil.example"));
        assert!(!loopback_origin("http://127.0.0.1.evil.example:80"));
        assert!(!loopback_origin("null"));
    }

    #[test]
    fn genesis_hash_is_not_a_cluster() {
        let ours = genesis_hash();
        assert_eq!(bs58::decode(&ours).into_vec().unwrap().len(), 32);
        for real in [
            "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
            "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
            "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
        ] {
            assert_ne!(ours, real);
        }
    }
}
