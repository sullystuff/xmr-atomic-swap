//! The built binary over real sockets: loopback-only binding, the HTTP envelope, the
//! browser rules, and program loading from the command line.

use {
    serde_json::{json, Value},
    std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpStream,
        process::{Child, Command, Stdio},
    },
};

const BIN: &str = env!("CARGO_BIN_EXE_svm-rpc");
const MEMO_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/memo.so");

struct Server {
    child: Child,
    port: u16,
}

impl Server {
    fn start(extra: &[&str]) -> Server {
        let mut child = Command::new(BIN)
            .args(["--port", "0", "--die-with-parent"])
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let url = line.trim().strip_prefix("svm-rpc listening on ").unwrap_or_else(|| panic!("unexpected banner: {line:?}"));
        let port = url.strip_prefix("http://127.0.0.1:").expect("loopback url").parse().unwrap();
        Server { child, port }
    }

    /// One HTTP/1.1 exchange on a fresh connection; returns `(status, headers, body)`.
    fn http(&self, method: &str, headers: &[(&str, &str)], body: &str) -> (u16, String, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        let mut req = format!("{method} / HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
            req.push_str(&format!("Host: 127.0.0.1:{}\r\n", self.port));
        }
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        req.push_str(body);
        stream.write_all(req.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, head.to_ascii_lowercase(), body.to_string())
    }

    fn rpc(&self, method: &str, params: Value) -> Value {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
        let (status, _, body) = self.http("POST", &[("Content-Type", "application/json")], &body);
        assert_eq!(status, 200, "{body}");
        serde_json::from_str(&body).unwrap()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn serves_json_rpc_on_loopback_and_keeps_state_between_requests() {
    let s = Server::start(&[]);
    assert_eq!(s.rpc("getHealth", json!([]))["result"], "ok");
    let key = "4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA";
    s.rpc("svm_airdrop", json!([key, 12345]));
    assert_eq!(s.rpc("getBalance", json!([key]))["result"]["value"], 12345);
    assert_eq!(s.rpc("getBalance", json!(["bad"]))["error"]["code"], -32602);
    let (status, _, body) = s.http("GET", &[], "");
    assert_eq!((status, body.as_str()), (200, "ok"));
    assert_eq!(s.http("PUT", &[], "").0, 405);

    // The listener is on 127.0.0.1 and nowhere else.
    let listening = std::fs::read_to_string("/proc/net/tcp").unwrap();
    let port_hex = format!(":{:04X} ", s.port);
    let rows: Vec<&str> = listening.lines().filter(|l| l.contains(&port_hex) && l.split_whitespace().nth(3) == Some("0A")).collect();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0].contains(&format!("0100007F:{:04X}", s.port)), "{rows:?}");
}

#[test]
fn refuses_every_other_bind_address() {
    for host in ["0.0.0.0", "::", "::1", "localhost", "10.0.0.1"] {
        for flag in ["--host", "--bind", "--bind-address"] {
            let out = Command::new(BIN).args([flag, host, "--port", "0"]).output().unwrap();
            assert_eq!(out.status.code(), Some(2), "{flag} {host}");
            assert!(String::from_utf8_lossy(&out.stderr).contains("127.0.0.1 only"), "{flag} {host}");
            assert!(out.stdout.is_empty(), "nothing was served for {flag} {host}");
        }
    }
    let out = Command::new(BIN).args(["--listen-everywhere"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    // Naming loopback explicitly is accepted.
    let s = Server::start(&["--host", "127.0.0.1"]);
    assert_eq!(s.rpc("getHealth", json!([]))["result"], "ok");
}

#[test]
fn browser_rules_cors_for_loopback_pages_only() {
    let s = Server::start(&[]);
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "getSlot" }).to_string();

    // A page served from loopback (the web UI under test) may call it, preflight included.
    let origin = ("Origin", "http://127.0.0.1:5173");
    let (status, head, _) = s.http("OPTIONS", &[origin, ("Access-Control-Request-Method", "POST"), ("Access-Control-Request-Headers", "content-type,solana-client")], "");
    assert_eq!(status, 204);
    assert!(head.contains("access-control-allow-origin: http://127.0.0.1:5173"), "{head}");
    assert!(head.contains("solana-client"), "{head}");
    let (status, head, out) = s.http("POST", &[origin, ("Content-Type", "application/json")], &body);
    assert_eq!(status, 200);
    assert!(head.contains("access-control-allow-origin: http://127.0.0.1:5173"), "{head}");
    assert!(serde_json::from_str::<Value>(&out).unwrap()["result"].is_u64());
    assert_eq!(s.http("POST", &[("Origin", "http://localhost:3000")], &body).0, 200);

    // Any other page is refused and gets no CORS header; so is a rebound host name.
    for bad in ["https://example.com", "http://127.0.0.1.example.com", "null"] {
        let (status, head, _) = s.http("POST", &[("Origin", bad)], &body);
        assert_eq!(status, 403, "{bad}");
        assert!(!head.contains("access-control-allow-origin"), "{bad}");
    }
    assert_eq!(s.http("POST", &[("Host", "attacker.example:80")], &body).0, 403);
    assert_eq!(s.http("POST", &[("Host", "localhost")], &body).0, 200);
}

#[test]
fn loads_programs_and_clock_from_the_command_line() {
    let id = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    let s = Server::start(&["--program", &format!("{id}={MEMO_FIXTURE}"), "--unix-timestamp", "1800000000"]);
    let info = s.rpc("getAccountInfo", json!([id]));
    assert_eq!(info["result"]["value"]["executable"], true);
    let slot = s.rpc("getSlot", json!([]))["result"].as_u64().unwrap();
    assert_eq!(s.rpc("getBlockTime", json!([slot]))["result"], 1_800_000_000i64);

    let out = Command::new(BIN).args(["--program", &format!("{id}=/nonexistent.so"), "--port", "0"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    let out = Command::new(BIN).args(["--program", "no-equals-sign"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn exits_when_the_parent_closes_stdin() {
    let mut s = Server::start(&[]);
    drop(s.child.stdin.take());
    let status = s.child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
    assert!(TcpStream::connect(("127.0.0.1", s.port)).is_err());
}
