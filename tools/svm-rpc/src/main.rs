use std::io::{Read, Write};

const USAGE: &str = "\
svm-rpc: loopback-only Solana JSON-RPC subset over one in-memory LiteSVM (a test fixture)

USAGE: svm-rpc [--port <n>] [--program <programId>=<path.so>]... [--unix-timestamp <secs>]
               [--die-with-parent] [--host 127.0.0.1]

  --port <n>              port on 127.0.0.1; 0 picks a free one (default 8899)
  --program <id>=<path>   load a built program at that id before serving (repeatable)
  --unix-timestamp <s>    starting Clock.unix_timestamp (default 1795000000)
  --die-with-parent       exit when stdin reaches end of file
  --host <addr>           accepted only as 127.0.0.1; anything else is refused

Prints `svm-rpc listening on http://127.0.0.1:<port>` on stdout once it serves.";

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("svm-rpc: {msg}");
    std::process::exit(2);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut port: u16 = 8899;
    let mut programs: Vec<(String, String)> = Vec::new();
    let mut unix_timestamp: Option<i64> = None;
    let mut die_with_parent = false;

    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().unwrap_or_else(|| fail(format!("{name} needs a value")));
        match arg.as_str() {
            "--host" | "--bind" | "--bind-address" => {
                if let Err(e) = svm_rpc::check_host(&value(&arg)) {
                    fail(e);
                }
            }
            "--port" => port = value("--port").parse().unwrap_or_else(|_| fail("--port must be 0..=65535")),
            "--program" => {
                let spec = value("--program");
                match spec.split_once('=') {
                    Some((id, path)) => programs.push((id.to_string(), path.to_string())),
                    None => fail("--program takes <programId>=<path.so>"),
                }
            }
            "--unix-timestamp" => {
                unix_timestamp = Some(value("--unix-timestamp").parse().unwrap_or_else(|_| fail("--unix-timestamp must be an integer")))
            }
            "--die-with-parent" => die_with_parent = true,
            "--help" | "-h" => {
                println!("{USAGE}");
                return;
            }
            other => fail(format!("unknown argument `{other}`\n\n{USAGE}")),
        }
    }

    let mut facade = svm_rpc::Facade::new();
    if let Some(t) = unix_timestamp {
        if let Err(e) = facade.call("svm_setClock", &serde_json::json!([t])) {
            fail(e.message);
        }
    }
    for (id, path) in &programs {
        if let Err(e) = facade.add_program_from_file(id, path) {
            fail(e);
        }
    }

    let (server, port) = svm_rpc::bind(port).unwrap_or_else(|e| fail(e));
    if die_with_parent {
        std::thread::spawn(|| {
            let mut sink = [0u8; 256];
            let mut stdin = std::io::stdin();
            while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
            std::process::exit(0);
        });
    }
    println!("svm-rpc listening on http://{}:{port}", svm_rpc::BIND_HOST);
    let _ = std::io::stdout().flush();
    svm_rpc::serve(server, facade);
}
