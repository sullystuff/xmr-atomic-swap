# Verifying the download

This page shows how to check that what you are running was built from a particular commit of this repository: the Solana program, the taker web UI and the maker console. The hashes to compare against are recorded in the repository itself, in `releases/`.

## What exists today, stated plainly

- **Nothing is deployed.** There is no program on any live network, so there is nothing on-chain to verify yet. The on-chain check below is implemented and tested against a stand-in on this machine only.
- **There is no release yet.** The only record is `releases/dev-snapshot`, a development snapshot. The program and both front ends are still changing; the snapshot exists so the tools and the format can be checked, not so that anyone relies on its hashes.
- **Nobody independent has verified anything.** A third-party verification record can only exist after a deployment. Until then the only evidence is what you reproduce yourself with the commands on this page.
- **A matching hash proves that a build matches the source. It does not prove the source is safe.** The software is unaudited.

## What each hash covers

A record is a directory, `releases/<version>/`, with three files:

| File | What it is |
| --- | --- |
| `release.json` | The commit, the tool versions, and the hashes below |
| `web.SHA256SUMS` | The SHA-256 of every file of the taker UI |
| `console.SHA256SUMS` | The SHA-256 of every file of the maker console |

The hashes in `release.json`:

| Field | Covers | Does not cover |
| --- | --- | --- |
| `web_tree_hash`, `console_tree_hash` | Every file of that front end: its path and its content. It is the SHA-256 of the `SHA256SUMS` file, which lists the files sorted by path. File order on disk, timestamps, owners and permissions play no part, so two copies with the same files always give the same hash. | Anything the page loads at run time from elsewhere (it loads nothing), your browser, your wallet extension, and the settings you give the page. |
| `web_cid`, `console_cid` | The same files, as an IPFS content identifier (CIDv1), computed on the build machine without any IPFS node. If the front end is ever published on IPFS with the parameters in `cid_params`, this is the address it will have. | Nothing is published on IPFS today. The value was not compared with an IPFS program on this machine (none is installed); it was checked against hand-built reference values in the tests. |
| `program_executable_hash` | The Solana program's machine code: the SHA-256 of the program file with its trailing zero bytes removed. This is exactly what `solana-verify get-executable-hash` prints, and what `solana-verify get-program-hash` prints for a deployed program. | The program's **upgrade authority**. While the project owner holds it, a verified program can be replaced by a different one tomorrow. It also does not cover the Ethereum contract, for which no build record exists yet. |
| `program_hash_source` | Says which build that hash comes from: `docker` (the canonical one, below) or `local` (the recorder's own machine). | |
| `program_builds` | Every recorded build of the program with its method: `local-sbf` or `solana-verify-docker`. | The two methods use different compiler versions and **give different hashes for the same source**. Never compare a hash of one method with a hash of the other. |
| `commit` | The source every artefact in the record was built from. | Whether that source does what it should. |

For the snapshot in this repository:

| | Value |
| --- | --- |
| Program, Docker build | `edae8238d4429ed6b0bbdce34ad761062f2cb5acd80affa8feaa130ba45e13ad` |
| Program, local build | `5ef2576ca8fcb4d4131d416ee21e1227b949b852467f6d9716ad13accc3e074e` |
| Taker UI tree hash | `db2ab83ad6f806497374788c6e9cfbafb0cfda55996e309485ce5bb1bc4c69a3` |
| Console tree hash | `c97baf4c2a8fa4c288e34a2a4d84a841b6d9ed504dbfeec514cfb1a0bcde9f03` |

These will change with the next change to the program or the front ends.

## Checking files you downloaded

If you were given a release directory (the three record files plus `web/`, `console/` and `program/xmr_swap.so`), check its files against the record:

```sh
pnpm --filter @xmrswap/deploy run verify deploy/release
```

Output for the snapshot's own release directory:

```text
Record   dev-snapshot (DEVELOPMENT SNAPSHOT, not a release)
commit   e3c18fa65d69d635f1c490636c2f4ba4a60a1885 (2026-11-27T18:01:38Z)
program  expected executable hash 5ef2576ca8fcb4d4131d416ee21e1227b949b852467f6d9716ad13accc3e074e (from the LOCAL build of the recorder's machine, not the Docker build)

MATCH        web      tree hash db2ab83ad6f806497374788c6e9cfbafb0cfda55996e309485ce5bb1bc4c69a3, 6 files, IPFS bafybeihgmq4wczciqlclwbvxdrl2wxjionrbssjymc5yibd4dki4j2upyq
MATCH        console  tree hash c97baf4c2a8fa4c288e34a2a4d84a841b6d9ed504dbfeec514cfb1a0bcde9f03, 3 files, IPFS bafybeihkfavpshczzosk6vpx2v24ram3c5teukn32r4jfpn2aoqpse6gem
MATCH        program  executable hash 5ef2576ca8fcb4d4131d416ee21e1227b949b852467f6d9716ad13accc3e074e (the record's local-sbf build)
NOT CHECKED  on-chain this record names no deployment: there is no on-chain program to verify yet
                      Once a program is deployed, compare it with: run verify <record> --onchain (RPC URL in SOLANA_RPC_URL).

3 matched, 1 not compared, against files on disk (nothing was rebuilt).
Files on disk matching the record shows the files are the recorded ones. Only a rebuild (--rebuild) shows that the record matches the source.
A match does not show that the source is safe: the software is unaudited.
```

The command exits with status 0 when nothing mismatches and 1 otherwise.

**The record you compare against must be the one in the repository**, at a commit you trust, not one that came in the same download. To check a downloaded UI against the repository's record:

```sh
pnpm --filter @xmrswap/deploy run verify releases/dev-snapshot --prebuilt web=deploy/release/web --only web
```

```text
MATCH        web      tree hash db2ab83ad6f806497374788c6e9cfbafb0cfda55996e309485ce5bb1bc4c69a3, 6 files, IPFS bafybeihgmq4wczciqlclwbvxdrl2wxjionrbssjymc5yibd4dki4j2upyq
```

You can check a tree hash with standard tools and nothing from this repository. Inside the directory of the front end:

```sh
cd deploy/release/web && find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum | sha256sum
```

```text
db2ab83ad6f806497374788c6e9cfbafb0cfda55996e309485ce5bb1bc4c69a3  -
```

And the program's hash with the Solana tool itself:

```sh
solana-verify get-executable-hash deploy/release/program/xmr_swap.so
```

```text
5ef2576ca8fcb4d4131d416ee21e1227b949b852467f6d9716ad13accc3e074e
```

A release directory also carries a plain `SHA256SUMS` over all its files. `node deploy/scripts/verify.mjs <directory>` checks it with no dependencies installed, and `sha256sum -c SHA256SUMS` inside the directory does the same with coreutils:

```sh
node deploy/scripts/verify.mjs deploy/release
```

```text
OK: 13 files match SHA256SUMS
sha256 of the list itself: 527db83e2aca696f8420aec8177a102d67676fdd755c8d22c54b8c2c4ae07ed8
```

To run the bundle from a verified release directory, point it at the `web` folder:

```sh
XMRSWAP_UI_DIST=release/web pnpm --filter @xmrswap/deploy start
```

The start command and the status command then say which record the served UI equals (see [The bundle says what it serves](#the-bundle-says-what-it-serves)).

## Rebuilding from source and comparing

This is the check that needs no trust in any download. It exports the record's commit into an empty temporary directory, builds everything there with each package's own build command, and compares the results with the record. Your working copy is not touched.

You need the build tools from the [quick start](quick-start.md#prerequisites) (Node, pnpm, Rust with the wasm target, `wasm-bindgen-cli` 0.2.130), and for the program the Solana tools (`cargo build-sbf`). The record's `tools` lists the versions that made it.

```sh
pnpm --filter @xmrswap/deploy run verify releases/dev-snapshot --offline
```

`--offline` makes pnpm and cargo fail rather than download; leave it out on a machine that has not built the project before. Output on the machine where this was written (about one minute):

```text
Record   dev-snapshot (DEVELOPMENT SNAPSHOT, not a release)
commit   e3c18fa65d69d635f1c490636c2f4ba4a60a1885 (2026-11-27T18:01:38Z)
program  expected executable hash edae8238d4429ed6b0bbdce34ad761062f2cb5acd80affa8feaa130ba45e13ad (from the Docker build)

Building web, console, program from commit e3c18fa65d69d635f1c490636c2f4ba4a60a1885.
build:
  install (3 s)
  wasm core (31 s)
  web UI (1 s)
  console (1 s)
  program (27 s)

MATCH        web      tree hash db2ab83ad6f806497374788c6e9cfbafb0cfda55996e309485ce5bb1bc4c69a3, 6 files, IPFS bafybeihgmq4wczciqlclwbvxdrl2wxjionrbssjymc5yibd4dki4j2upyq
MATCH        console  tree hash c97baf4c2a8fa4c288e34a2a4d84a841b6d9ed504dbfeec514cfb1a0bcde9f03, 3 files, IPFS bafybeihkfavpshczzosk6vpx2v24ram3c5teukn32r4jfpn2aoqpse6gem
MATCH        program  executable hash 5ef2576ca8fcb4d4131d416ee21e1227b949b852467f6d9716ad13accc3e074e (local-sbf)
NOT CHECKED  on-chain this record names no deployment: there is no on-chain program to verify yet
                      Once a program is deployed, compare it with: run verify <record> --onchain (RPC URL in SOLANA_RPC_URL).

3 matched, 1 not compared, against a rebuild from commit e3c18fa65d69.
A match does not show that the source is safe: the software is unaudited.
```

Add `--only web`, `--only console` or `--only program` to rebuild one artefact. The program line here compares your **local** build with the record's local build; the canonical program check is the Docker build in the next section.

### How far this is known to reproduce

What was tested on the machine where this was written, and what was not:

| Artefact | Tested | Result |
| --- | --- | --- |
| Console | Built twice from clean in two different directories | Identical |
| Taker UI | The same, with the cargo home at a different path for the second build | Identical, **given the path remapping described below** |
| Program, local build | Built twice from clean in two different directories | Identical |
| Program, Docker build | Built twice from clean in two different directories | Identical |
| Any of them on a second machine, another operating system or another CPU type | **Not tested** | Unknown |

The taker UI contains the cryptographic core compiled from Rust to WebAssembly. Built the ordinary way, that file contains the absolute paths of the checkout and of your cargo directory, so **the ordinary build gives a different taker UI in every directory and for every user name**. The release and verify commands add compiler flags that replace those two paths with fixed names (the record's `wasm_rustflags`); with them the result was the same in different directories. A UI built with plain `pnpm --filter @xmrswap/web build` will therefore **not** match a record, and that alone is not a sign of tampering. Build it through `run verify` or `run release` to compare.

If your local program build differs although your tools match the record's: a cargo directory that is reached through a symbolic link is one known cause (the compiler then writes the link's path into the program).

## The program: local build and Docker build

There are two ways to build the program and they are recorded separately.

| Method | Command | Use |
| --- | --- | --- |
| `local-sbf` | `cargo build-sbf -- --locked` in `solana/program` | Quick. The result depends on the Solana tools installed on your machine, so it only matches someone else's build if they have the same versions. |
| `solana-verify-docker` | `solana-verify build --library-name xmr_swap` in `solana/program` | **The canonical build.** It compiles inside a Docker image that `solana-verify` pins by digest, so the tools are the same for everyone. A release's `program_executable_hash` must come from this build. |

For the snapshot the two hashes differ, as expected: the Docker image contains `cargo-build-sbf` 2.3.0 with platform-tools v1.48, and the local build on the recording machine used `cargo-build-sbf` 3.0.9 with platform-tools v1.51. A different compiler gives different machine code from the same source. Neither is wrong; they are simply not comparable.

To repeat the Docker build you need Docker (rootless Docker works; it was run that way here), git, and `solana-verify` 0.4 or later. Version 0.2 cannot read this program's lock file. The pinned version is installed with `cargo install solana-verify --version 0.4.11 --locked`. Then:

```sh
bash deploy/scripts/program-docker-build.sh e3c18fa65d69d635f1c490636c2f4ba4a60a1885
```

The script exports that commit's `solana/program` into two temporary directories, builds each in Docker, and requires the two results to be equal. The first run downloads the build image (about 3 GB) and the program's dependencies. Output:

```text
Building solana/program of commit e3c18fa65d69d635f1c490636c2f4ba4a60a1885 in Docker with solana-verify 0.4.11, twice.
build 1: executable hash edae8238d4429ed6b0bbdce34ad761062f2cb5acd80affa8feaa130ba45e13ad
build 2: executable hash edae8238d4429ed6b0bbdce34ad761062f2cb5acd80affa8feaa130ba45e13ad
The two Docker builds are identical.
image: solanafoundation/solana-verifiable-build@sha256:1e6f3097794495fa968c9e07d4da6adcdabf28efc6ddb0314c2e9e72b57a7a34
```

Compare the hash with the `solana-verify-docker` entry of `program_builds` in the record. The script builds only: it uses no wallet, contacts no cluster and publishes no port.

## Comparing the program on-chain

**There is no deployed program today, so this section describes a check you cannot make yet.** It was tested here only against a stand-in RPC on this machine.

Once the program is deployed, what matters is that the machine code on-chain is the build the record names. Give the tool a Solana RPC URL through the environment (it is never printed) and add `--onchain`. Not run against a real cluster on the machine where this was written:

```sh not-run
export SOLANA_RPC_URL='<your Solana RPC URL>'
pnpm --filter @xmrswap/deploy run verify releases/<version> --onchain --only program
```

It reads the program's account and its data account (two read-only requests; no wallet, no transaction), drops the 45-byte header, strips the trailing zero bytes and hashes the rest. When the hash equals a recorded build it prints a line of this form:

```text
MATCH        on-chain program <program id> has executable hash <hash>, the record's solana-verify-docker build
                      upgrade authority: <address>: that key can still replace the program
```

Read the upgrade authority line. While it names an address, the holder of that key can replace the program, and a check made today says nothing about tomorrow. Only `upgrade authority: none: the program is immutable` makes the result permanent.

With nothing deployed, the same command prints `no program at <program id> on the cluster behind SOLANA_RPC_URL` and says that this is expected.

You do not need this repository for the on-chain half. The Solana tool reads the same value. Not run against a real cluster on the machine where this was written:

```sh not-run
solana-verify get-program-hash -u '<your Solana RPC URL>' <program id>
```

Compare its output with the Docker build's hash in the record, and with your own Docker build of the record's commit. After a deployment the project can also be checked in one step by `solana-verify verify-from-repo`, which builds a given commit of a public repository in Docker and compares it with the chain; that command needs a deployed program and has not been run.

## What a mismatch means

| What you see | Likely cause | What to do |
| --- | --- | --- |
| `MISMATCH web` or `console`, with `changed`, `missing` or `extra` files listed | The files are not the recorded build. For a download: it was altered or is a different version. For your own build: you built a different commit, or built the UI the ordinary way without the path remapping. | Do not use a download that mismatches. For your own build, rebuild with `run verify`. |
| `MISMATCH program` on a local rebuild | Your Solana tools differ from the record's `tools`, or the cargo directory is behind a symbolic link. | Compare tool versions. Use the Docker build, which does not depend on your tools. |
| The Docker build gives a different hash than the record | This should not happen: the image is pinned. Either the commit differs, or the record is wrong, or the build is not as deterministic as believed. | Check the commit. If it is right, treat the record as unverified and report it. |
| `NOT COMPARED program` | You supplied a build made with a method the record does not hold. | Build with a recorded method. Never compare across methods. |
| `MISMATCH on-chain` | The deployed program is not a build in the record: it was upgraded after the record was made, or it was built from other source. | **Do not swap.** The program on-chain is not the reviewed source. |
| `web.SHA256SUMS is not the list web_tree_hash commits to` | A record file was edited or mixed with another record's. | Take the record from the repository again. |
| The status command says `Served UI is not a recorded build` | You are serving your own build, a newer commit, or changed files. | Fine for development. For real use, serve a build that matches a record. |

A mismatch never proves an attack, and a match never proves safety. A mismatch means: what you have is not what the record describes, so the record tells you nothing about it.

## The bundle says what it serves

When the bundle starts it hashes the UI directory it is about to serve and looks in `releases/` for a record with that tree hash. The start command prints the result:

```text
Build:        recorded build dev-snapshot (development-snapshot), commit e3c18fa65d69
              UI tree hash db2ab83ad6f806497374788c6e9cfbafb0cfda55996e309485ce5bb1bc4c69a3
```

The status command has a line for it (`ok    Served UI is the recorded build dev-snapshot`, or `warn  Served UI is not a recorded build`), and the same information is served at `http://127.0.0.1:8780/release.json` for the page to show.

Be clear about what this is worth: it is the server describing itself. It tells you which build you are running if your copy of the bundle is honest, and helps you notice an accidental mix-up. It cannot protect you from a bundle that was tampered with, because a tampered server can print anything. The checks earlier on this page, run on the files, are the real ones.

## Checking the program id and contract address

The page and the relay act on one Solana program and one Ethereum contract. The release pins both. They must agree with each other **and with the published values**.

1. What the source code pins:

   ```sh
   pnpm --filter @xmrswap/deploy run pinned
   ```

   Output for this version:

   ```text
   program id (Solana)          5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u
   contract address (Ethereum)  (none: no contract is deployed for this release)
   contract chain id            (none)
   ```

   In this version the program id is a development id and there is no contract address, because nothing has been deployed.

2. What a record pins: `program_id` and `contract` in `release.json`.

3. What the running page uses: the Status page (`http://127.0.0.1:8780/#/status`) shows "Program id" and "Ethereum contract" under "This browser", and the Settings page shows them under "Program and contract". The status command compares the page's value with the pinned one:

   ```text
   ok    Program id is the one this release pins
         5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u. Compare it with the published id yourself; see "Verifying the download".
   ```

   If it prints `warn  Program id differs from the one this release pins`, stop: the settings file or the environment overrides the program id. Remove `program_id` from `deploy/xmrswap.toml` and unset `RELAY_PROGRAM_ID`.

Once the project publishes a program id, compare with at least two independent sources (for example the project's announcement and a block explorer page for the program), and compare the whole string, not just the first and last characters.

If you saved settings in the page earlier, the browser's saved program id and contract address take precedence over the bundle's. After upgrading to a release that pins new values, check the Settings page.

The Status page also has a line for each chain's upgrade status: "still upgradable", "immutable", or "upgrade status unknown". Until it says "immutable", the project owner can change the contract. "Unknown" means the page could not read it; treat that as upgradable.

## Making a record

For whoever cuts a release. Build everything from a commit, twice, in two different directories, and refuse unless the results are identical:

```sh
pnpm --filter @xmrswap/deploy run release --offline --record
```

Output (about two minutes):

```text
Building web, console, program from commit e3c18fa65d69d635f1c490636c2f4ba4a60a1885, twice, in two directories.
build 1:
  install (3 s)
  wasm core (30 s)
  web UI (1 s)
  console (1 s)
  program (27 s)
build 2 (different directory; the wasm core also with the cargo home at a different path):
  install (3 s)
  wasm core (30 s)
  web UI (1 s)
  console (1 s)
  program (27 s)
The two builds are identical.

release directory  <repository>/deploy/release
version            dev-snapshot (development-snapshot)
commit             e3c18fa65d69d635f1c490636c2f4ba4a60a1885
program            executable hash 5ef2576ca8fcb4d4131d416ee21e1227b949b852467f6d9716ad13accc3e074e (local-sbf)
                   solana-verify get-executable-hash prints the same value
web                tree hash db2ab83ad6f806497374788c6e9cfbafb0cfda55996e309485ce5bb1bc4c69a3
                   IPFS bafybeihgmq4wczciqlclwbvxdrl2wxjionrbssjymc5yibd4dki4j2upyq
console            tree hash c97baf4c2a8fa4c288e34a2a4d84a841b6d9ed504dbfeec514cfb1a0bcde9f03
                   IPFS bafybeihkfavpshczzosk6vpx2v24ram3c5teukn32r4jfpn2aoqpse6gem
double build       identical in two directories
recorded           releases/dev-snapshot/ (release.json, web.SHA256SUMS, console.SHA256SUMS)

The program hash is this machine's local build. The hash a release must carry comes from the Docker build: see deploy/scripts/program-docker-build.sh.
Nothing was deployed or published. There is no on-chain program to verify yet.
```

Then add the canonical program build to the record:

```sh
bash deploy/scripts/program-docker-build.sh --record releases/dev-snapshot
```

Its last lines:

```text
recorded solana-verify-docker build in <repository>/releases/dev-snapshot/release.json: executable hash edae8238d4429ed6b0bbdce34ad761062f2cb5acd80affa8feaa130ba45e13ad
program_executable_hash is now edae8238d4429ed6b0bbdce34ad761062f2cb5acd80affa8feaa130ba45e13ad (source: docker)
local-sbf build: 5ef2576ca8fcb4d4131d416ee21e1227b949b852467f6d9716ad13accc3e074e (different, as expected for a different toolchain; never compare across methods)
Nothing was deployed. To compare a deployed program later: solana-verify get-program-hash -u <your RPC URL> <program id>
```

A real release additionally needs `--status release --version <version>`. The tools refuse to call something a release unless its program hash comes from the Docker build and its dependencies were installed exactly from the committed lock file. Neither command deploys, signs or publishes anything.
