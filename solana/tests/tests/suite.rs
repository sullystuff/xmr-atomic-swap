//! The whole LiteSVM suite is one test binary (see Cargo.toml).
#[path = "suite/common.rs"]
mod common;
#[path = "suite/happy.rs"]
mod happy;
#[path = "suite/replay.rs"]
mod replay;
#[path = "suite/approval.rs"]
mod approval;
#[path = "suite/crypto.rs"]
mod crypto;
#[path = "suite/refund_table.rs"]
mod refund_table;
#[path = "suite/deposits.rs"]
mod deposits;
#[path = "suite/binding.rs"]
mod binding;
#[path = "suite/fees.rs"]
mod fees;
#[path = "suite/deadlines.rs"]
mod deadlines;
#[path = "suite/session.rs"]
mod session;
#[path = "suite/park.rs"]
mod park;
