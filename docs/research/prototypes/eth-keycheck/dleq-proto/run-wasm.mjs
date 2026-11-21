// Runs the raw wasm32-unknown-unknown build in V8 (same engine as Chrome) and times prove/verify.
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const bytes = readFileSync(process.argv[2]);
const { instance } = await WebAssembly.instantiate(bytes, {});
const e = instance.exports;
const mem = () => new Uint8Array(e.memory.buffer, e.buf(), 131072);
const hex = (u) => Buffer.from(u).toString('hex');
const runs = 10;
for (const lib of ['serai', 'sigma']) {
  if (lib === 'sigma') e.sigma_init();
  let tp = 0, tv = 0, len = 0, last;
  for (let i = 0; i < runs; i++) {
    const seed = webcrypto.getRandomValues(new Uint8Array(64));
    if (lib === 'sigma') seed[63] &= 0x0f; // secret < 2^252 (LE)
    mem().set(seed, 0);
    let t = performance.now(); len = e[lib + '_prove'](); tp += performance.now() - t;
    last = mem().slice(0, 129);
    t = performance.now(); const ok = e[lib + '_verify'](); tv += performance.now() - t;
    if (ok !== 1) throw new Error(lib + ' verify failed');
    // tamper: must fail
    mem()[129 + 500] ^= 1;
    if (e[lib + '_verify']() !== 0) throw new Error(lib + ' accepted tampered proof');
  }
  console.log(`${lib} wasm: proof ${len} bytes, prove ${(tp / runs).toFixed(1)} ms, verify ${(tv / runs).toFixed(1)} ms; sample s=0x${hex(last.slice(0, 32))} ed=0x${hex(last.slice(97, 129))}`);
}
console.log('wasm size', bytes.length, 'bytes; node', process.version);
