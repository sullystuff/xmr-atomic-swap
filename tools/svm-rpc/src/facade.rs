//! The JSON-RPC surface of docs/SPEC.md section 9.2 over one in-memory LiteSVM.
//!
//! Chain model (there is no ledger and no consensus):
//! - Every transaction that lands gets its own slot: it is recorded at the current slot, then
//!   the slot and block height move by one and a new blockhash is issued. Nothing else moves
//!   the slot except `svm_warp` and `svm_setClock`; wall-clock time never does.
//! - A blockhash is accepted for `BLOCKHASH_TTL` block heights after it was issued, as on a
//!   cluster. `svm_warp` expires every blockhash issued before it.
//! - Every commitment level is final.

use {
    crate::token,
    base64::{engine::general_purpose::STANDARD as B64, Engine},
    litesvm::{types::TransactionMetadata, LiteSVM},
    serde_json::{json, Map, Value},
    sha2::{Digest, Sha256},
    solana_account::{Account, ReadableAccount},
    solana_clock::Clock,
    solana_hash::Hash,
    solana_message::{compiled_instruction::CompiledInstruction, VersionedMessage},
    solana_pubkey::Pubkey,
    solana_signature::Signature,
    solana_transaction::versioned::VersionedTransaction,
    std::{collections::HashMap, str::FromStr},
};

pub const INITIAL_SLOT: u64 = 300_000_000;
pub const INITIAL_UNIX_TIMESTAMP: i64 = 1_795_000_000;
/// Block height trails the slot by a constant, so the two are never mistaken for each other.
pub const HEIGHT_LAG: u64 = 20_000_000;
pub const BLOCKHASH_TTL: u64 = 150;
/// Mainnet-beta's Rent sysvar (docs/research/solana-curve.md); LiteSVM still defaults to 6,960.
pub const LAMPORTS_PER_BYTE: u64 = 5_080;
pub const SLOTS_PER_EPOCH: u64 = 432_000;
const LOOKUP_TABLE_META_SIZE: usize = 56;

const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;
const PREFLIGHT_FAILURE: i64 = -32002;
const UNSUPPORTED_TX_VERSION: i64 = -32015;
const TX_HISTORY_NOT_AVAILABLE: i64 = -32011;

#[derive(Debug)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

type RpcResult = Result<Value, RpcError>;

fn invalid(msg: impl Into<String>) -> RpcError {
    RpcError { code: INVALID_PARAMS, message: format!("Invalid params: {}", msg.into()), data: None }
}

struct TxRecord {
    signature: Signature,
    slot: u64,
    block_time: i64,
    err: Value,
    tx: VersionedTransaction,
    raw: Vec<u8>,
    meta: TransactionMetadata,
    loaded_writable: Vec<Pubkey>,
    loaded_readonly: Vec<Pubkey>,
    pre_balances: Vec<u64>,
    post_balances: Vec<u64>,
    pre_token_balances: Vec<Value>,
    post_token_balances: Vec<Value>,
}

pub struct Facade {
    svm: Option<LiteSVM>,
    txs: Vec<TxRecord>,
    by_signature: HashMap<Signature, usize>,
    by_address: HashMap<Pubkey, Vec<usize>>,
    /// Blockhash to the slot it was issued at.
    blockhashes: HashMap<Hash, u64>,
    /// `(slot, unix_timestamp)` each time the clock changed, ascending by slot.
    clock_log: Vec<(u64, i64)>,
    unique_counter: u64,
}

impl Default for Facade {
    fn default() -> Self {
        Self::new()
    }
}

impl Facade {
    pub fn new() -> Self {
        // LiteSVM::new(): mainnet feature set, builtins, sysvars, SPL Token / Token-2022 / ATA /
        // Memo / address-lookup-table programs, signature verification on. Its own blockhash
        // check only knows the single latest hash, so it is replaced by the window kept here.
        let mut svm = LiteSVM::new().with_blockhash_check(false);
        svm.set_sysvar(&solana_rent::Rent::with_lamports_per_byte(LAMPORTS_PER_BYTE));
        let mut facade = Facade {
            svm: Some(svm),
            txs: Vec::new(),
            by_signature: HashMap::new(),
            by_address: HashMap::new(),
            blockhashes: HashMap::new(),
            clock_log: Vec::new(),
            unique_counter: 0,
        };
        facade.set_clock(INITIAL_SLOT, INITIAL_UNIX_TIMESTAMP);
        facade.new_blockhash();
        facade
    }

    fn svm(&self) -> &LiteSVM {
        self.svm.as_ref().expect("svm present")
    }

    fn svm_mut(&mut self) -> &mut LiteSVM {
        self.svm.as_mut().expect("svm present")
    }

    // ---- clock, slots, blockhashes -------------------------------------------------------

    fn clock(&self) -> Clock {
        self.svm().get_sysvar::<Clock>()
    }

    pub fn slot(&self) -> u64 {
        self.clock().slot
    }

    pub fn unix_timestamp(&self) -> i64 {
        self.clock().unix_timestamp
    }

    fn height(&self) -> u64 {
        self.slot() - HEIGHT_LAG
    }

    fn set_clock(&mut self, slot: u64, unix_timestamp: i64) {
        let mut clock = self.clock();
        clock.slot = slot;
        clock.unix_timestamp = unix_timestamp;
        self.svm_mut().set_sysvar(&clock);
        match self.clock_log.last_mut() {
            Some(last) if last.0 == slot => last.1 = unix_timestamp,
            _ => self.clock_log.push((slot, unix_timestamp)),
        }
    }

    fn new_blockhash(&mut self) {
        self.svm_mut().expire_blockhash();
        let (hash, slot) = (self.svm().latest_blockhash(), self.slot());
        self.blockhashes.insert(hash, slot);
        self.blockhashes.retain(|_, issued| slot - *issued <= BLOCKHASH_TTL);
    }

    fn blockhash_valid(&self, hash: &Hash) -> bool {
        self.blockhashes.get(hash).is_some_and(|issued| self.slot() - issued <= BLOCKHASH_TTL)
    }

    fn block_time(&self, slot: u64) -> Option<i64> {
        if slot > self.slot() {
            return None;
        }
        let idx = self.clock_log.partition_point(|(s, _)| *s <= slot);
        idx.checked_sub(1).map(|i| self.clock_log[i].1)
    }

    fn context(&self) -> Value {
        json!({ "apiVersion": crate::SOLANA_CORE_VERSION, "slot": self.slot() })
    }

    fn with_context(&self, value: Value) -> Value {
        json!({ "context": self.context(), "value": value })
    }

    /// A fresh address that is the same on every run: sha256 of a counter.
    fn unique_address(&mut self) -> Pubkey {
        self.unique_counter += 1;
        let mut h = Sha256::new();
        h.update(b"svm-rpc unique address");
        h.update(self.unique_counter.to_le_bytes());
        Pubkey::new_from_array(h.finalize().into())
    }

    // ---- accounts ------------------------------------------------------------------------

    fn account(&self, key: &Pubkey) -> Option<Account> {
        self.svm().get_account(key).filter(|a| a.lamports > 0)
    }

    fn mint_decimals(&self, mint: &Pubkey) -> Option<u8> {
        let acc = self.account(mint)?;
        token::is_token_program(&acc.owner).then(|| token::read_mint(&acc.data)).flatten().map(|m| m.decimals)
    }

    fn encode_account(&self, acc: &Account, cfg: &AccountConfig) -> RpcResult {
        let sliced: &[u8] = match cfg.slice {
            Some((offset, length)) => {
                let start = offset.min(acc.data.len());
                &acc.data[start..start.saturating_add(length).min(acc.data.len())]
            }
            None => &acc.data,
        };
        let data = match cfg.encoding.as_str() {
            "base64" => json!([B64.encode(sliced), "base64"]),
            "base58" => {
                if sliced.len() > 128 {
                    return Err(invalid("base58 encoding is limited to 128 bytes of account data; use base64"));
                }
                json!([bs58::encode(sliced).into_string(), "base58"])
            }
            "jsonParsed" => match self.parse_account(acc) {
                Some(parsed) => parsed,
                None => json!([B64.encode(sliced), "base64"]),
            },
            other => return Err(invalid(format!("unsupported account encoding `{other}`"))),
        };
        Ok(json!({
            "lamports": acc.lamports,
            "owner": acc.owner.to_string(),
            "data": data,
            "executable": acc.executable,
            "rentEpoch": acc.rent_epoch,
            "space": acc.data.len(),
        }))
    }

    /// `jsonParsed` is implemented for SPL Token mints and token accounts only.
    fn parse_account(&self, acc: &Account) -> Option<Value> {
        if !token::is_token_program(&acc.owner) {
            return None;
        }
        let program = if acc.owner == token::token_program() { "spl-token" } else { "spl-token-2022" };
        let parsed = if let Some(a) = token::read_account(&acc.data) {
            token::parsed_account(&a, self.mint_decimals(&a.mint)?)
        } else {
            token::parsed_mint(&token::read_mint(&acc.data)?)
        };
        Some(json!({ "program": program, "parsed": parsed, "space": acc.data.len() }))
    }

    fn get_account_info(&self, p: &Params) -> RpcResult {
        let cfg = AccountConfig::parse(p.opt(1))?;
        let value = match self.account(&p.pubkey(0)?) {
            Some(acc) => self.encode_account(&acc, &cfg)?,
            None => Value::Null,
        };
        Ok(self.with_context(value))
    }

    fn get_multiple_accounts(&self, p: &Params) -> RpcResult {
        let cfg = AccountConfig::parse(p.opt(1))?;
        let keys = p.array(0)?;
        if keys.len() > 100 {
            return Err(invalid("too many inputs provided; max 100"));
        }
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            out.push(match self.account(&parse_pubkey(k)?) {
                Some(acc) => self.encode_account(&acc, &cfg)?,
                None => Value::Null,
            });
        }
        Ok(self.with_context(Value::Array(out)))
    }

    /// Accounts whose owner passes `owner_ok` and whose content passes `pred`, as the
    /// `{pubkey, account}` list of the RPC API.
    fn keyed_accounts(
        &self,
        owner_ok: impl Fn(&Pubkey) -> bool,
        pred: impl Fn(&Account) -> bool,
        cfg: &AccountConfig,
    ) -> Result<Vec<Value>, RpcError> {
        let mut hits: Vec<(Pubkey, Account)> = self
            .svm()
            .accounts_db()
            .inner
            .iter()
            .filter(|(_, a)| a.lamports() > 0 && owner_ok(a.owner()))
            .map(|(k, a)| (*k, Account::from(a.clone())))
            .filter(|(_, a)| pred(a))
            .collect();
        // A node returns these in no particular order; sorted here so tests are repeatable.
        hits.sort_by_key(|(k, _)| k.to_string());
        hits.iter()
            .map(|(k, a)| Ok(json!({ "pubkey": k.to_string(), "account": self.encode_account(a, cfg)? })))
            .collect()
    }

    fn get_program_accounts(&self, p: &Params) -> RpcResult {
        let program = p.pubkey(0)?;
        let cfg_value = p.opt(1);
        let cfg = AccountConfig::parse(cfg_value)?;
        let filters = parse_filters(cfg_value.and_then(|c| c.get("filters")))?;
        let list = self.keyed_accounts(|o| *o == program, |a| filters.iter().all(|f| f.matches(&a.data)), &cfg)?;
        let with_context = cfg_value.and_then(|c| c.get("withContext")).and_then(Value::as_bool).unwrap_or(false);
        Ok(if with_context { self.with_context(Value::Array(list)) } else { Value::Array(list) })
    }

    fn get_token_accounts_by_owner(&self, p: &Params) -> RpcResult {
        let owner = p.pubkey(0)?;
        let selector = p.get(1)?;
        let (mint, program) = if let Some(m) = selector.get("mint") {
            let mint = parse_pubkey(m)?;
            if self.mint_decimals(&mint).is_none() {
                return Err(invalid("Token mint could not be unpacked"));
            }
            (Some(mint), None)
        } else if let Some(pid) = selector.get("programId") {
            let pid = parse_pubkey(pid)?;
            if !token::is_token_program(&pid) {
                return Err(invalid("unrecognized Token program id"));
            }
            (None, Some(pid))
        } else {
            return Err(invalid("expected {mint} or {programId}"));
        };
        let cfg = AccountConfig::parse(p.opt(2))?;
        let list = self.keyed_accounts(
            |o| token::is_token_program(o) && program.is_none_or(|pid| *o == pid),
            |a| token::read_account(&a.data).is_some_and(|t| t.owner == owner && mint.is_none_or(|m| t.mint == m)),
            &cfg,
        )?;
        Ok(self.with_context(Value::Array(list)))
    }

    fn get_token_account_balance(&self, p: &Params) -> RpcResult {
        let not_token = || invalid("not a Token account");
        let acc = self.account(&p.pubkey(0)?).ok_or_else(|| invalid("could not find account"))?;
        if !token::is_token_program(&acc.owner) {
            return Err(not_token());
        }
        let t = token::read_account(&acc.data).ok_or_else(not_token)?;
        let decimals = self.mint_decimals(&t.mint).ok_or_else(|| invalid("could not find mint"))?;
        Ok(self.with_context(token::ui_amount(t.amount, decimals)))
    }

    // ---- transactions --------------------------------------------------------------------

    /// Static keys, then writable and readonly addresses loaded from lookup tables.
    fn resolve_keys(&self, msg: &VersionedMessage) -> (Vec<Pubkey>, Vec<Pubkey>, Vec<Pubkey>) {
        let (mut writable, mut readonly) = (Vec::new(), Vec::new());
        for lookup in msg.address_table_lookups().unwrap_or(&[]) {
            let table = self.account(&lookup.account_key).map(|a| a.data).unwrap_or_default();
            let entry = |i: &u8| {
                let start = LOOKUP_TABLE_META_SIZE + *i as usize * 32;
                table.get(start..start + 32).map(|b| Pubkey::new_from_array(b.try_into().unwrap()))
            };
            writable.extend(lookup.writable_indexes.iter().filter_map(entry));
            readonly.extend(lookup.readonly_indexes.iter().filter_map(entry));
        }
        (msg.static_account_keys().to_vec(), writable, readonly)
    }

    fn token_balances(&self, keys: &[Pubkey]) -> Vec<Value> {
        keys.iter()
            .enumerate()
            .filter_map(|(i, k)| {
                let acc = self.account(k)?;
                if !token::is_token_program(&acc.owner) {
                    return None;
                }
                let t = token::read_account(&acc.data)?;
                Some(json!({
                    "accountIndex": i,
                    "mint": t.mint.to_string(),
                    "owner": t.owner.to_string(),
                    "programId": acc.owner.to_string(),
                    "uiTokenAmount": token::ui_amount(t.amount, self.mint_decimals(&t.mint)?),
                }))
            })
            .collect()
    }

    fn balances(&self, keys: &[Pubkey]) -> Vec<u64> {
        keys.iter().map(|k| self.svm().get_balance(k).unwrap_or(0)).collect()
    }

    fn simulation_failure(&self, err: &litesvm::types::FailedTransactionMetadata) -> RpcError {
        RpcError {
            code: PREFLIGHT_FAILURE,
            message: format!("Transaction simulation failed: {}", err.err),
            data: Some(json!({
                "err": tx_error_json(&err.err),
                "logs": err.meta.logs,
                "accounts": null,
                "unitsConsumed": err.meta.compute_units_consumed,
                "returnData": null,
                "innerInstructions": null,
            })),
        }
    }

    fn rejected(&self, err: solana_transaction_error::TransactionError) -> RpcError {
        self.simulation_failure(&litesvm::types::FailedTransactionMetadata { err, meta: Default::default() })
    }

    fn send_transaction(&mut self, p: &Params) -> RpcResult {
        let cfg = p.opt(1);
        let (tx, raw) = decode_transaction(p.str(0)?, cfg, "base58")?;
        let skip_preflight = cfg.and_then(|c| c.get("skipPreflight")).and_then(Value::as_bool).unwrap_or(false);
        let signature = *tx.signatures.first().ok_or_else(|| invalid("transaction has no signatures"))?;

        // A node accepts a transaction it will never include when preflight is skipped: the
        // caller gets the signature and `getSignatureStatuses` stays null.
        use solana_transaction_error::TransactionError as E;
        if self.by_signature.contains_key(&signature) {
            return if skip_preflight { Ok(json!(signature.to_string())) } else { Err(self.rejected(E::AlreadyProcessed)) };
        }
        if !self.blockhash_valid(tx.message.recent_blockhash()) {
            return if skip_preflight { Ok(json!(signature.to_string())) } else { Err(self.rejected(E::BlockhashNotFound)) };
        }
        if !skip_preflight {
            if let Err(failed) = self.svm().simulate_transaction(tx.clone()) {
                return Err(self.simulation_failure(&failed));
            }
        }

        let (static_keys, loaded_writable, loaded_readonly) = self.resolve_keys(&tx.message);
        let keys: Vec<Pubkey> = static_keys.iter().chain(&loaded_writable).chain(&loaded_readonly).copied().collect();
        let pre_balances = self.balances(&keys);
        let pre_token_balances = self.token_balances(&keys);

        let (meta, err) = match self.svm_mut().send_transaction(tx.clone()) {
            Ok(meta) => (meta, Value::Null),
            Err(failed) => {
                // LiteSVM keeps a failed transaction in its history only when it was included
                // (fee charged). Anything else never reached a block.
                if self.svm().get_transaction(&signature).is_none() {
                    return Err(self.simulation_failure(&failed));
                }
                (failed.meta, tx_error_json(&failed.err))
            }
        };

        let idx = self.txs.len();
        for k in &keys {
            let list = self.by_address.entry(*k).or_default();
            if list.last() != Some(&idx) {
                list.push(idx);
            }
        }
        self.by_signature.insert(signature, idx);
        self.txs.push(TxRecord {
            signature,
            slot: self.slot(),
            block_time: self.unix_timestamp(),
            err,
            post_balances: self.balances(&keys),
            post_token_balances: self.token_balances(&keys),
            tx,
            raw,
            meta,
            loaded_writable,
            loaded_readonly,
            pre_balances,
            pre_token_balances,
        });
        self.set_clock(self.slot() + 1, self.unix_timestamp());
        self.new_blockhash();
        Ok(json!(signature.to_string()))
    }

    fn simulate_transaction(&mut self, p: &Params) -> RpcResult {
        let cfg = p.opt(1);
        let flag = |name: &str| cfg.and_then(|c| c.get(name)).and_then(Value::as_bool).unwrap_or(false);
        let (tx, _) = decode_transaction(p.str(0)?, cfg, "base58")?;
        let (sig_verify, replace_blockhash) = (flag("sigVerify"), flag("replaceRecentBlockhash"));
        if sig_verify && replace_blockhash {
            return Err(invalid("sigVerify may not be used with replaceRecentBlockhash"));
        }
        let account_cfg = cfg.and_then(|c| c.get("accounts"));
        let addresses: Vec<Pubkey> = match account_cfg.and_then(|a| a.get("addresses")).and_then(Value::as_array) {
            Some(list) => list.iter().map(parse_pubkey).collect::<Result<_, _>>()?,
            None => Vec::new(),
        };
        let encoding = AccountConfig::parse(account_cfg)?;

        let result = if !replace_blockhash && !self.blockhash_valid(tx.message.recent_blockhash()) {
            Err(litesvm::types::FailedTransactionMetadata {
                err: solana_transaction_error::TransactionError::BlockhashNotFound,
                meta: Default::default(),
            })
        } else if sig_verify {
            self.svm().simulate_transaction(tx)
        } else {
            // Signature verification is a builder switch on LiteSVM.
            let svm = self.svm.take().expect("svm present").with_sigverify(false);
            let result = svm.simulate_transaction(tx);
            self.svm = Some(svm.with_sigverify(true));
            result
        };

        let (err, meta, post) = match result {
            Ok(info) => (Value::Null, info.meta, info.post_accounts),
            Err(failed) => (tx_error_json(&failed.err), failed.meta, Vec::new()),
        };
        let accounts = if account_cfg.is_some() {
            let mut out = Vec::new();
            for key in &addresses {
                let acc = post.iter().find(|(k, _)| k == key).map(|(_, a)| Account::from(a.clone())).or_else(|| self.account(key));
                out.push(match acc.filter(|a| a.lamports > 0) {
                    Some(a) => self.encode_account(&a, &encoding)?,
                    None => Value::Null,
                });
            }
            Value::Array(out)
        } else {
            Value::Null
        };
        let return_data = if meta.return_data.data.is_empty() {
            Value::Null
        } else {
            json!({ "programId": meta.return_data.program_id.to_string(), "data": [B64.encode(&meta.return_data.data), "base64"] })
        };
        let inner = if flag("innerInstructions") { inner_instructions_json(&meta) } else { Value::Null };
        Ok(self.with_context(json!({
            "err": err,
            "logs": meta.logs,
            "accounts": accounts,
            "unitsConsumed": meta.compute_units_consumed,
            "returnData": return_data,
            "innerInstructions": inner,
            "replacementBlockhash": null,
        })))
    }

    fn get_fee_for_message(&mut self, p: &Params) -> RpcResult {
        let bytes = B64.decode(p.str(0)?).map_err(|e| invalid(format!("message is not base64: {e}")))?;
        let message: VersionedMessage = bincode::deserialize(&bytes).map_err(|e| invalid(format!("failed to deserialize message: {e}")))?;
        if !self.blockhash_valid(message.recent_blockhash()) {
            return Ok(self.with_context(Value::Null));
        }
        let signers = message.header().num_required_signatures as usize;
        let tx = VersionedTransaction { signatures: vec![Signature::default(); signers], message };
        // The fee LiteSVM would charge, taken from an unsigned dry run: signatures (precompile
        // signatures included) plus the priority fee.
        let svm = self.svm.take().expect("svm present").with_sigverify(false);
        let fee = match svm.simulate_transaction(tx) {
            Ok(info) => info.meta.fee,
            Err(failed) => failed.meta.fee,
        };
        self.svm = Some(svm.with_sigverify(true));
        let fee = if fee == 0 { 5_000 * signers as u64 } else { fee };
        Ok(self.with_context(json!(fee)))
    }

    fn get_signature_statuses(&self, p: &Params) -> RpcResult {
        let sigs = p.array(0)?;
        if sigs.len() > 256 {
            return Err(invalid("too many inputs provided; max 256"));
        }
        let mut out = Vec::with_capacity(sigs.len());
        for s in sigs {
            let sig = parse_signature(s)?;
            out.push(match self.by_signature.get(&sig).map(|i| &self.txs[*i]) {
                Some(rec) => json!({
                    "slot": rec.slot,
                    "confirmations": null,
                    "err": rec.err,
                    "status": status_json(&rec.err),
                    "confirmationStatus": "finalized",
                }),
                None => Value::Null,
            });
        }
        Ok(self.with_context(Value::Array(out)))
    }

    fn get_signatures_for_address(&self, p: &Params) -> RpcResult {
        let address = p.pubkey(0)?;
        let cfg = p.opt(1);
        let limit = match cfg.and_then(|c| c.get("limit")) {
            Some(v) => v.as_u64().filter(|n| (1..=1000).contains(n)).ok_or_else(|| invalid("limit must be 1..=1000"))? as usize,
            None => 1000,
        };
        let bound = |name: &str| -> Result<Option<Signature>, RpcError> {
            cfg.and_then(|c| c.get(name)).filter(|v| !v.is_null()).map(parse_signature).transpose()
        };
        let (before, until) = (bound("before")?, bound("until")?);
        let mut started = before.is_none();
        let mut out = Vec::new();
        for idx in self.by_address.get(&address).into_iter().flatten().rev() {
            let rec = &self.txs[*idx];
            if !started {
                started = Some(rec.signature) == before;
                continue;
            }
            if Some(rec.signature) == until || out.len() == limit {
                break;
            }
            out.push(json!({
                "signature": rec.signature.to_string(),
                "slot": rec.slot,
                "err": rec.err,
                "memo": null,
                "blockTime": rec.block_time,
                "confirmationStatus": "finalized",
            }));
        }
        Ok(Value::Array(out))
    }

    fn get_transaction(&self, p: &Params) -> RpcResult {
        let sig = parse_signature(p.get(0)?)?;
        let cfg = p.opt(1);
        // The config may be a bare encoding string (the legacy form).
        let encoding = match cfg {
            Some(Value::String(s)) => s.as_str(),
            Some(c) => c.get("encoding").and_then(Value::as_str).unwrap_or("json"),
            None => "json",
        };
        let max_version = cfg.and_then(|c| c.get("maxSupportedTransactionVersion")).and_then(Value::as_u64);
        let Some(rec) = self.by_signature.get(&sig).map(|i| &self.txs[*i]) else {
            return Ok(Value::Null);
        };
        let version = match &rec.tx.message {
            VersionedMessage::Legacy(_) => json!("legacy"),
            VersionedMessage::V0(_) => json!(0),
            _ => json!(1),
        };
        if let Some(v) = version.as_u64() {
            if max_version.is_none_or(|max| v > max) {
                return Err(RpcError {
                    code: UNSUPPORTED_TX_VERSION,
                    message: format!("Transaction version ({v}) is not supported by the requesting client. Please try the request again with the following configuration parameter: \"maxSupportedTransactionVersion\": {v}"),
                    data: None,
                });
            }
        }
        let transaction = match encoding {
            "json" => transaction_json(&rec.tx),
            "base64" => json!([B64.encode(&rec.raw), "base64"]),
            "base58" => json!([bs58::encode(&rec.raw).into_string(), "base58"]),
            other => return Err(invalid(format!("unsupported transaction encoding `{other}` (json, base64 and base58 are implemented)"))),
        };
        let keys = |list: &[Pubkey]| list.iter().map(Pubkey::to_string).collect::<Vec<_>>();
        let mut meta = json!({
            "err": rec.err,
            "status": status_json(&rec.err),
            "fee": rec.meta.fee,
            "preBalances": rec.pre_balances,
            "postBalances": rec.post_balances,
            "innerInstructions": inner_instructions_json(&rec.meta),
            "logMessages": rec.meta.logs,
            "preTokenBalances": rec.pre_token_balances,
            "postTokenBalances": rec.post_token_balances,
            "rewards": [],
            "loadedAddresses": { "writable": keys(&rec.loaded_writable), "readonly": keys(&rec.loaded_readonly) },
            "computeUnitsConsumed": rec.meta.compute_units_consumed,
        });
        if !rec.meta.return_data.data.is_empty() {
            meta["returnData"] = json!({
                "programId": rec.meta.return_data.program_id.to_string(),
                "data": [B64.encode(&rec.meta.return_data.data), "base64"],
            });
        }
        Ok(json!({
            "slot": rec.slot,
            "blockTime": rec.block_time,
            "transaction": transaction,
            "meta": meta,
            "version": version,
        }))
    }

    // ---- control methods -----------------------------------------------------------------

    fn set_account_checked(&mut self, key: Pubkey, account: Account) -> Result<(), RpcError> {
        self.svm_mut().set_account(key, account).map_err(|e| invalid(format!("LiteSVM refused the account: {e}")))
    }

    fn rent_exempt(&self, len: usize) -> u64 {
        self.svm().minimum_balance_for_rent_exemption(len)
    }

    fn add_program(&mut self, program_id: Pubkey, path: &str) -> RpcResult {
        self.svm_mut()
            .add_program_from_file(program_id, path)
            .map_err(|e| invalid(format!("cannot load program from `{path}`: {e}")))?;
        let program_data = Pubkey::find_program_address(&[program_id.as_ref()], &upgradeable_loader()).0;
        Ok(json!({ "programId": program_id.to_string(), "programData": program_data.to_string() }))
    }

    pub fn add_program_from_file(&mut self, program_id: &str, path: &str) -> Result<(), String> {
        let id = Pubkey::from_str(program_id).map_err(|e| format!("bad program id `{program_id}`: {e}"))?;
        self.add_program(id, path).map(|_| ()).map_err(|e| e.message)
    }

    /// Rewrites the `upgrade_authority_address` option of the ProgramData account
    /// (`UpgradeableLoaderState::ProgramData`: u32 tag 3, u64 slot, Option<Pubkey>).
    fn set_upgrade_authority(&mut self, p: &Params) -> RpcResult {
        let program_id = p.pubkey(0)?;
        let authority = match p.opt(1) {
            Some(v) => Some(parse_pubkey(v)?),
            None => None,
        };
        let program_data = Pubkey::find_program_address(&[program_id.as_ref()], &upgradeable_loader()).0;
        let mut acc = self
            .account(&program_data)
            .filter(|a| a.owner == upgradeable_loader() && a.data.len() >= 45 && a.data[..4] == 3u32.to_le_bytes())
            .ok_or_else(|| invalid("no upgradeable program is loaded at that id"))?;
        acc.data[12..45].fill(0);
        if let Some(a) = authority {
            acc.data[12] = 1;
            acc.data[13..45].copy_from_slice(a.as_ref());
        }
        self.set_account_checked(program_data, acc)?;
        Ok(Value::Null)
    }

    fn airdrop(&mut self, p: &Params) -> RpcResult {
        let (key, lamports) = (p.pubkey(0)?, p.u64(1)?);
        let mut acc = self.account(&key).unwrap_or_default();
        acc.lamports = acc.lamports.checked_add(lamports).ok_or_else(|| invalid("balance overflow"))?;
        let balance = acc.lamports;
        self.set_account_checked(key, acc)?;
        Ok(json!(balance.to_string()))
    }

    fn clock_json(&self) -> Value {
        json!({ "slot": self.slot(), "blockHeight": self.height(), "unixTimestamp": self.unix_timestamp() })
    }

    fn warp(&mut self, p: &Params) -> RpcResult {
        let seconds = p.u64(0)?;
        let slots = seconds.checked_mul(5).map(|n| n / 2).ok_or_else(|| invalid("seconds too large"))?;
        let unix = i64::try_from(seconds).ok().and_then(|s| self.unix_timestamp().checked_add(s));
        let (Some(unix), Some(slot)) = (unix, self.slot().checked_add(slots.max(1))) else {
            return Err(invalid("seconds too large"));
        };
        self.set_clock(slot, unix);
        self.blockhashes.clear();
        self.new_blockhash();
        Ok(self.clock_json())
    }

    fn set_clock_rpc(&mut self, p: &Params) -> RpcResult {
        let unix = p.i64(0)?;
        self.set_clock(self.slot() + 1, unix);
        self.new_blockhash();
        Ok(self.clock_json())
    }

    fn create_mint(&mut self, p: &Params) -> RpcResult {
        let decimals = u8::try_from(p.u64(0)?).map_err(|_| invalid("decimals must fit in a u8"))?;
        let authority = p.pubkey(1)?;
        let mint = match p.opt(2) {
            Some(v) => parse_pubkey(v)?,
            None => self.unique_address(),
        };
        if self.account(&mint).is_some() {
            return Err(invalid("an account already exists at the mint address"));
        }
        let account = Account {
            lamports: self.rent_exempt(token::MINT_LEN),
            data: token::pack_mint(&authority, decimals, 0),
            owner: token::token_program(),
            executable: false,
            rent_epoch: u64::MAX,
        };
        self.set_account_checked(mint, account)?;
        Ok(json!(mint.to_string()))
    }

    /// Credits the owner's associated token account, creating it when missing, and raises the
    /// mint's supply. No transaction is involved, so no authority has to sign.
    fn mint_to(&mut self, p: &Params) -> RpcResult {
        let (mint, owner, amount) = (p.pubkey(0)?, p.pubkey(1)?, p.u64(2)?);
        let mut mint_acc = self
            .account(&mint)
            .filter(|a| a.owner == token::token_program())
            .ok_or_else(|| invalid("not a mint of the SPL Token program"))?;
        let supply = token::read_mint(&mint_acc.data).ok_or_else(|| invalid("not an initialised mint"))?.supply;
        let ata = token::associated_token_address(&owner, &mint);
        let mut ata_acc = match self.account(&ata) {
            Some(acc) => acc,
            None => Account {
                lamports: self.rent_exempt(token::ACCOUNT_LEN),
                data: token::pack_account(&mint, &owner, 0),
                owner: token::token_program(),
                executable: false,
                rent_epoch: u64::MAX,
            },
        };
        let held = token::read_account(&ata_acc.data).ok_or_else(|| invalid("the associated token address holds something else"))?.amount;
        let overflow = || invalid("amount overflows a u64");
        token::set_amount(&mut ata_acc.data, held.checked_add(amount).ok_or_else(overflow)?);
        token::set_supply(&mut mint_acc.data, supply.checked_add(amount).ok_or_else(overflow)?);
        self.set_account_checked(ata, ata_acc)?;
        self.set_account_checked(mint, mint_acc)?;
        Ok(json!(ata.to_string()))
    }

    fn set_token_account_frozen(&mut self, p: &Params) -> RpcResult {
        let key = p.pubkey(0)?;
        let frozen = p.get(1)?.as_bool().ok_or_else(|| invalid("frozen must be a boolean"))?;
        let mut acc = self
            .account(&key)
            .filter(|a| token::is_token_program(&a.owner) && token::read_account(&a.data).is_some())
            .ok_or_else(|| invalid("not a Token account"))?;
        token::set_frozen(&mut acc.data, frozen);
        self.set_account_checked(key, acc)?;
        Ok(Value::Null)
    }

    fn set_account_rpc(&mut self, p: &Params) -> RpcResult {
        let key = p.pubkey(0)?;
        let spec = p.get(1)?;
        if spec.is_null() {
            self.set_account_checked(key, Account::default())?;
            return Ok(Value::Null);
        }
        let data = match spec.get("data") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::String(s)) => B64.decode(s).map_err(|e| invalid(format!("data is not base64: {e}")))?,
            Some(Value::Array(pair)) if pair.len() == 2 && pair[1] == "base64" => {
                B64.decode(pair[0].as_str().unwrap_or("")).map_err(|e| invalid(format!("data is not base64: {e}")))?
            }
            Some(_) => return Err(invalid("data must be a base64 string or [base64, \"base64\"]")),
        };
        let account = Account {
            lamports: parse_u64(spec.get("lamports").ok_or_else(|| invalid("lamports is required"))?)?,
            owner: match spec.get("owner") {
                Some(v) => parse_pubkey(v)?,
                None => Pubkey::default(),
            },
            executable: spec.get("executable").and_then(Value::as_bool).unwrap_or(false),
            rent_epoch: match spec.get("rentEpoch") {
                Some(v) if !v.is_null() => parse_u64(v)?,
                _ => u64::MAX,
            },
            data,
        };
        self.set_account_checked(key, account)?;
        Ok(Value::Null)
    }

    /// Writes an active address lookup table directly (`ProgramState::LookupTable`: u32 tag 1,
    /// deactivation slot, last extended slot, start index, Option<authority>, padding; then the
    /// addresses). `last_extended_slot` is 0, so every address is usable at once.
    fn create_lookup_table(&mut self, p: &Params) -> RpcResult {
        let addresses: Vec<Pubkey> = p.array(0)?.iter().map(parse_pubkey).collect::<Result<_, _>>()?;
        if addresses.len() > 256 {
            return Err(invalid("a lookup table holds at most 256 addresses"));
        }
        let authority = match p.opt(1) {
            Some(v) => Some(parse_pubkey(v)?),
            None => None,
        };
        let mut data = vec![0u8; LOOKUP_TABLE_META_SIZE];
        data[0..4].copy_from_slice(&1u32.to_le_bytes());
        data[4..12].copy_from_slice(&u64::MAX.to_le_bytes());
        if let Some(a) = authority {
            data[21] = 1;
            data[22..54].copy_from_slice(a.as_ref());
        }
        for a in &addresses {
            data.extend_from_slice(a.as_ref());
        }
        let table = self.unique_address();
        let account = Account {
            lamports: self.rent_exempt(data.len()),
            data,
            owner: lookup_table_program(),
            executable: false,
            rent_epoch: u64::MAX,
        };
        self.set_account_checked(table, account)?;
        Ok(json!(table.to_string()))
    }

    // ---- dispatch ------------------------------------------------------------------------

    pub fn call(&mut self, method: &str, params: &Value) -> RpcResult {
        let p = &Params::new(params)?;
        match method {
            "getAccountInfo" => self.get_account_info(p),
            "getMultipleAccounts" => self.get_multiple_accounts(p),
            "getProgramAccounts" => self.get_program_accounts(p),
            "getBalance" => Ok(self.with_context(json!(self.account(&p.pubkey(0)?).map_or(0, |a| a.lamports)))),
            "getTokenAccountBalance" => self.get_token_account_balance(p),
            "getTokenAccountsByOwner" => self.get_token_accounts_by_owner(p),
            "getLatestBlockhash" => {
                let hash = self.svm().latest_blockhash();
                Ok(self.with_context(json!({
                    "blockhash": hash.to_string(),
                    "lastValidBlockHeight": self.blockhashes[&hash] - HEIGHT_LAG + BLOCKHASH_TTL,
                })))
            }
            "isBlockhashValid" => {
                let hash = Hash::from_str(p.str(0)?).map_err(|e| invalid(format!("bad blockhash: {e}")))?;
                Ok(self.with_context(json!(self.blockhash_valid(&hash))))
            }
            "getMinimumBalanceForRentExemption" => {
                let len = usize::try_from(p.u64(0)?).map_err(|_| invalid("length too large"))?;
                Ok(json!(self.rent_exempt(len)))
            }
            "getFeeForMessage" => self.get_fee_for_message(p),
            "getRecentPrioritizationFees" => Ok(json!([{ "slot": self.slot(), "prioritizationFee": 0 }])),
            "sendTransaction" => self.send_transaction(p),
            "simulateTransaction" => self.simulate_transaction(p),
            "getSignatureStatuses" => self.get_signature_statuses(p),
            "getSignaturesForAddress" => self.get_signatures_for_address(p),
            "getTransaction" => self.get_transaction(p),
            "getSlot" => Ok(json!(self.slot())),
            "getBlockHeight" => Ok(json!(self.height())),
            "getBlockTime" => {
                let slot = p.u64(0)?;
                self.block_time(slot).map(|t| json!(t)).ok_or_else(|| RpcError {
                    code: TX_HISTORY_NOT_AVAILABLE,
                    message: format!("Block not available for slot {slot}"),
                    data: None,
                })
            }
            "getEpochInfo" => Ok(json!({
                "absoluteSlot": self.slot(),
                "blockHeight": self.height(),
                "epoch": self.slot() / SLOTS_PER_EPOCH,
                "slotIndex": self.slot() % SLOTS_PER_EPOCH,
                "slotsInEpoch": SLOTS_PER_EPOCH,
                "transactionCount": self.txs.len(),
            })),
            "getGenesisHash" => Ok(json!(crate::genesis_hash())),
            "getVersion" => Ok(json!({ "solana-core": crate::SOLANA_CORE_VERSION, "feature-set": 0 })),
            "getHealth" => Ok(json!("ok")),

            "svm_addProgram" => self.add_program(p.pubkey(0)?, p.str(1)?),
            "svm_setUpgradeAuthority" => self.set_upgrade_authority(p),
            "svm_airdrop" => self.airdrop(p),
            "svm_warp" => self.warp(p),
            "svm_setClock" => self.set_clock_rpc(p),
            "svm_createMint" => self.create_mint(p),
            "svm_mintTo" => self.mint_to(p),
            "svm_setTokenAccountFrozen" => self.set_token_account_frozen(p),
            "svm_setAccount" => self.set_account_rpc(p),
            "svm_createLookupTable" => self.create_lookup_table(p),
            _ => Err(RpcError { code: METHOD_NOT_FOUND, message: format!("Method not found: {method} (svm-rpc implements the subset of docs/SPEC.md 9.2)"), data: None }),
        }
    }

    /// One JSON-RPC request object in, one response object out.
    fn handle_one(&mut self, req: &Value) -> Value {
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let result = match req.get("method").and_then(Value::as_str) {
            Some(method) => self.call(method, req.get("params").unwrap_or(&Value::Null)),
            None => Err(RpcError { code: -32600, message: "Invalid request".into(), data: None }),
        };
        match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "result": result, "id": id }),
            Err(e) => {
                let mut error = Map::new();
                error.insert("code".into(), json!(e.code));
                error.insert("message".into(), json!(e.message));
                if let Some(data) = e.data {
                    error.insert("data".into(), data);
                }
                json!({ "jsonrpc": "2.0", "error": error, "id": id })
            }
        }
    }

    /// A request body (single or batch) in, the response body out.
    pub fn handle_body(&mut self, body: &[u8]) -> String {
        let response = match serde_json::from_slice::<Value>(body) {
            Ok(Value::Array(batch)) if !batch.is_empty() => Value::Array(batch.iter().map(|r| self.handle_one(r)).collect()),
            Ok(req @ Value::Object(_)) => self.handle_one(&req),
            Ok(_) => json!({ "jsonrpc": "2.0", "error": { "code": -32600, "message": "Invalid request" }, "id": null }),
            Err(e) => json!({ "jsonrpc": "2.0", "error": { "code": -32700, "message": format!("Parse error: {e}") }, "id": null }),
        };
        response.to_string()
    }
}

// ---- parameter and encoding helpers ------------------------------------------------------

struct Params<'a>(&'a [Value]);

impl<'a> Params<'a> {
    fn new(v: &'a Value) -> Result<Self, RpcError> {
        match v {
            Value::Array(a) => Ok(Params(a)),
            Value::Null => Ok(Params(&[])),
            _ => Err(invalid("params must be an array")),
        }
    }
    fn get(&self, i: usize) -> Result<&'a Value, RpcError> {
        self.0.get(i).ok_or_else(|| invalid(format!("missing parameter {i}")))
    }
    /// An optional parameter; JSON null counts as absent.
    fn opt(&self, i: usize) -> Option<&'a Value> {
        self.0.get(i).filter(|v| !v.is_null())
    }
    fn str(&self, i: usize) -> Result<&'a str, RpcError> {
        self.get(i)?.as_str().ok_or_else(|| invalid(format!("parameter {i} must be a string")))
    }
    fn pubkey(&self, i: usize) -> Result<Pubkey, RpcError> {
        parse_pubkey(self.get(i)?)
    }
    fn u64(&self, i: usize) -> Result<u64, RpcError> {
        parse_u64(self.get(i)?)
    }
    fn i64(&self, i: usize) -> Result<i64, RpcError> {
        let v = self.get(i)?;
        v.as_i64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            .ok_or_else(|| invalid(format!("parameter {i} must be an integer or a decimal string")))
    }
    fn array(&self, i: usize) -> Result<&'a Vec<Value>, RpcError> {
        self.get(i)?.as_array().ok_or_else(|| invalid(format!("parameter {i} must be an array")))
    }
}

/// Amounts are accepted as JSON integers or decimal strings (SPEC 1.5: never a float).
fn parse_u64(v: &Value) -> Result<u64, RpcError> {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| invalid("expected a non-negative integer or a decimal string"))
}

fn parse_pubkey(v: &Value) -> Result<Pubkey, RpcError> {
    let s = v.as_str().ok_or_else(|| invalid("expected a base58 public key"))?;
    Pubkey::from_str(s).map_err(|e| invalid(format!("bad public key `{s}`: {e}")))
}

fn parse_signature(v: &Value) -> Result<Signature, RpcError> {
    let s = v.as_str().ok_or_else(|| invalid("expected a base58 signature"))?;
    Signature::from_str(s).map_err(|e| invalid(format!("bad signature `{s}`: {e}")))
}

fn upgradeable_loader() -> Pubkey {
    Pubkey::from_str("BPFLoaderUpgradeab1e11111111111111111111111").unwrap()
}

fn lookup_table_program() -> Pubkey {
    Pubkey::from_str("AddressLookupTab1e1111111111111111111111111").unwrap()
}

struct AccountConfig {
    encoding: String,
    slice: Option<(usize, usize)>,
}

impl AccountConfig {
    fn parse(cfg: Option<&Value>) -> Result<Self, RpcError> {
        let encoding = cfg.and_then(|c| c.get("encoding")).and_then(Value::as_str).unwrap_or("base64").to_string();
        let slice = match cfg.and_then(|c| c.get("dataSlice")).filter(|v| !v.is_null()) {
            Some(s) => {
                let field = |name: &str| s.get(name).and_then(Value::as_u64).ok_or_else(|| invalid("dataSlice needs offset and length"));
                Some((field("offset")? as usize, field("length")? as usize))
            }
            None => None,
        };
        Ok(AccountConfig { encoding, slice })
    }
}

enum Filter {
    DataSize(usize),
    Memcmp { offset: usize, bytes: Vec<u8> },
}

impl Filter {
    fn matches(&self, data: &[u8]) -> bool {
        match self {
            Filter::DataSize(n) => data.len() == *n,
            Filter::Memcmp { offset, bytes } => {
                offset.checked_add(bytes.len()).and_then(|end| data.get(*offset..end)).is_some_and(|d| d == bytes.as_slice())
            }
        }
    }
}

fn parse_filters(v: Option<&Value>) -> Result<Vec<Filter>, RpcError> {
    let Some(list) = v.filter(|v| !v.is_null()) else {
        return Ok(Vec::new());
    };
    let list = list.as_array().ok_or_else(|| invalid("filters must be an array"))?;
    if list.len() > 4 {
        return Err(invalid("too many filters provided; max 4"));
    }
    list.iter()
        .map(|f| {
            if let Some(n) = f.get("dataSize") {
                return Ok(Filter::DataSize(n.as_u64().ok_or_else(|| invalid("dataSize must be an integer"))? as usize));
            }
            let m = f.get("memcmp").ok_or_else(|| invalid("only memcmp and dataSize filters are implemented"))?;
            let offset = m.get("offset").and_then(Value::as_u64).ok_or_else(|| invalid("memcmp.offset must be an integer"))? as usize;
            let text = m.get("bytes").and_then(Value::as_str).ok_or_else(|| invalid("memcmp.bytes must be a string"))?;
            let bytes = match m.get("encoding").and_then(Value::as_str).unwrap_or("base58") {
                "base58" => bs58::decode(text).into_vec().map_err(|e| invalid(format!("memcmp.bytes is not base58: {e}")))?,
                "base64" => B64.decode(text).map_err(|e| invalid(format!("memcmp.bytes is not base64: {e}")))?,
                other => return Err(invalid(format!("unsupported memcmp encoding `{other}`"))),
            };
            if bytes.len() > 128 {
                return Err(invalid("memcmp.bytes is limited to 128 bytes"));
            }
            Ok(Filter::Memcmp { offset, bytes })
        })
        .collect()
}

fn decode_transaction(text: &str, cfg: Option<&Value>, default_encoding: &str) -> Result<(VersionedTransaction, Vec<u8>), RpcError> {
    let raw = match cfg.and_then(|c| c.get("encoding")).and_then(Value::as_str).unwrap_or(default_encoding) {
        "base64" => B64.decode(text).map_err(|e| invalid(format!("transaction is not base64: {e}")))?,
        "base58" => bs58::decode(text).into_vec().map_err(|e| invalid(format!("transaction is not base58: {e}")))?,
        other => return Err(invalid(format!("unsupported transaction encoding `{other}`"))),
    };
    if raw.len() > 1232 {
        return Err(invalid(format!("transaction too large: {} bytes (max: 1232 bytes)", raw.len())));
    }
    let tx: VersionedTransaction = bincode::deserialize(&raw).map_err(|e| invalid(format!("failed to deserialize transaction: {e}")))?;
    Ok((tx, raw))
}

/// The JSON a node gives for a `TransactionError`, e.g. `{"InstructionError":[0,{"Custom":6000}]}`.
fn tx_error_json(err: &solana_transaction_error::TransactionError) -> Value {
    serde_json::to_value(err).unwrap_or_else(|_| json!(err.to_string()))
}

fn status_json(err: &Value) -> Value {
    if err.is_null() {
        json!({ "Ok": null })
    } else {
        json!({ "Err": err })
    }
}

fn instruction_json(ix: &CompiledInstruction, stack_height: Option<u8>) -> Value {
    json!({
        "programIdIndex": ix.program_id_index,
        "accounts": ix.accounts,
        "data": bs58::encode(&ix.data).into_string(),
        "stackHeight": stack_height,
    })
}

fn inner_instructions_json(meta: &TransactionMetadata) -> Value {
    meta.inner_instructions
        .iter()
        .enumerate()
        .filter(|(_, list)| !list.is_empty())
        .map(|(index, list)| {
            json!({
                "index": index,
                "instructions": list.iter().map(|i| instruction_json(&i.instruction, Some(i.stack_height))).collect::<Vec<_>>(),
            })
        })
        .collect()
}

fn transaction_json(tx: &VersionedTransaction) -> Value {
    let msg = &tx.message;
    let header = msg.header();
    let mut message = json!({
        "header": {
            "numRequiredSignatures": header.num_required_signatures,
            "numReadonlySignedAccounts": header.num_readonly_signed_accounts,
            "numReadonlyUnsignedAccounts": header.num_readonly_unsigned_accounts,
        },
        "accountKeys": msg.static_account_keys().iter().map(Pubkey::to_string).collect::<Vec<_>>(),
        "recentBlockhash": msg.recent_blockhash().to_string(),
        "instructions": msg.instructions().iter().map(|ix| instruction_json(ix, None)).collect::<Vec<_>>(),
    });
    if let Some(lookups) = msg.address_table_lookups() {
        message["addressTableLookups"] = lookups
            .iter()
            .map(|l| json!({ "accountKey": l.account_key.to_string(), "writableIndexes": l.writable_indexes, "readonlyIndexes": l.readonly_indexes }))
            .collect();
    }
    json!({
        "signatures": tx.signatures.iter().map(Signature::to_string).collect::<Vec<_>>(),
        "message": message,
    })
}
