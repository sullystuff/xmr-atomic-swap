// @solana/web3.js and the Anchor coder expect Node's Buffer as a global.
import { Buffer } from 'buffer';

const g = globalThis as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
