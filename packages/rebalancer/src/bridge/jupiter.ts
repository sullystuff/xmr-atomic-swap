/**
 * Jupiter `swap/v1` client for the DEX leg (docs/research/local-assets.md, section 4): `GET
 * /quote` exact-in, then `POST /swap` for a base64 versioned transaction that the maker's
 * wallet signs through `ExecContext`.
 */
import { VersionedTransaction } from '@solana/web3.js';
import { type HttpClient, obj, query, requestJson, str } from '../http.js';

export const JUPITER_BASE = 'https://lite-api.jup.ag/swap/v1';

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Worst case after slippage. */
  minOutAmount: bigint;
  priceImpactPct: number;
  /** The response exactly as received; `POST /swap` wants it back unchanged. */
  raw: unknown;
}

export interface JupiterOptions { http: HttpClient; baseUrl?: string; slippageBps?: number; /** Cap on the priority fee, lamports. */ maxPriorityFeeLamports?: number }

export class JupiterClient {
  private readonly base: string;
  constructor(private readonly o: JupiterOptions) { this.base = o.baseUrl ?? JUPITER_BASE; }

  async quote(inputMint: string, outputMint: string, amount: bigint): Promise<JupiterQuote> {
    const url = `${this.base}/quote` + query({ inputMint, outputMint, amount: amount.toString(), swapMode: 'ExactIn', slippageBps: this.o.slippageBps ?? 50, restrictIntermediateTokens: true });
    const r = obj(await requestJson(this.o.http, { method: 'GET', url }), 'jupiter quote');
    const q: JupiterQuote = {
      inputMint: str(r['inputMint'], 'jupiter inputMint'), outputMint: str(r['outputMint'], 'jupiter outputMint'),
      inAmount: BigInt(str(r['inAmount'], 'jupiter inAmount')), outAmount: BigInt(str(r['outAmount'], 'jupiter outAmount')),
      minOutAmount: BigInt(str(r['otherAmountThreshold'], 'jupiter otherAmountThreshold')),
      priceImpactPct: Math.abs(Number(r['priceImpactPct'] ?? 0)) * 100, raw: r,
    };
    if (q.inputMint !== inputMint || q.outputMint !== outputMint || q.inAmount !== amount) throw new Error('jupiter: the quote is for a different swap than the one asked for');
    return q;
  }

  /** Returns the swap transaction after checking that the maker's wallet is its fee payer and only signer. */
  async swapTransaction(quote: JupiterQuote, wallet: string): Promise<string> {
    const body = JSON.stringify({
      quoteResponse: quote.raw, userPublicKey: wallet, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: this.o.maxPriorityFeeLamports ?? 1_000_000, priorityLevel: 'high' } },
    });
    const r = obj(await requestJson(this.o.http, { method: 'POST', url: `${this.base}/swap`, headers: { 'content-type': 'application/json' }, body }), 'jupiter swap');
    const b64 = str(r['swapTransaction'], 'jupiter swapTransaction');
    let tx: VersionedTransaction;
    try { tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64')); } catch { throw new Error('jupiter: the swap transaction does not parse'); }
    const keys = tx.message.staticAccountKeys;
    if (tx.message.header.numRequiredSignatures !== 1 || keys[0]?.toBase58() !== wallet) throw new Error('jupiter: the swap transaction is not payable and signable by the maker wallet alone');
    return b64;
  }
}
