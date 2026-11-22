# Verifying the download

Before you run the interface with real funds, check two things: that the files you have are the published ones, and that the page is pointed at the published program and contract. A changed page, or a page pointed at a different program, can take your funds.

## What exists today, stated plainly

- **Nothing is deployed to a live network yet**, and the project has not yet published release checksums or a signing key. So there is, today, no published value to compare against. This page describes the tools the bundle ships and how to use them once values are published.
- Checksums only prove that your files match a list. **They are only as trustworthy as the place you got the list from.** If an attacker can change the download, they can usually change a checksum file sitting next to it. Get the published checksum from a different channel than the download, or build from source and compare.

## Checksums

A release of the web UI is a directory:

```text
release/
  SHA256SUMS        one line per file: its SHA-256, two spaces, its path
  release.json      the program id and contract address this build pins
  web/              the built interface (index.html and assets)
```

Verify it with the script in the repository. It is plain Node with no dependencies, so you can run it before installing anything:

```sh
node deploy/scripts/verify.mjs deploy/release
```

Expected output when every file matches (your numbers will differ):

```text
OK: 7 files match SHA256SUMS
sha256 of the list itself: 809c2427025159cd14b37d699b877a453cc4c3c903ab3fd2facb23980581a358
```

Then **compare the last line with the published value**, character by character. That one value covers every file in the release. If it matches, the release is the published one.

If any file was changed, is missing, or was added, the script says which and exits with an error:

```text
CHANGED       web/assets/index-Dwi1VtgP.js
FAILED: 1 problem. Do not use these files.
```

Do not use a release that fails. Download it again from the official source.

The list is in the standard `sha256sum` format, so you can also check it without this repository:

```sh
cd deploy/release && sha256sum -c SHA256SUMS
```

```text
release.json: OK
web/assets/index-Dwi1VtgP.js: OK
web/assets/index-s9gXaUbD.css: OK
web/assets/swap_core-Ck49gtaE.js: OK
web/assets/swap_core_bg-DFg0tEyE.wasm: OK
web/favicon.svg: OK
web/index.html: OK
```

`sha256sum -c` does not notice extra files that are not in the list; `verify.mjs` does.

To run the bundle from a verified release directory instead of a build, point `[ui] dist` at its `web` folder. With the release at `deploy/release`:

```sh
XMRSWAP_UI_DIST=release/web pnpm --filter @xmrswap/deploy start
```

## Building from source and comparing

You can also build the interface yourself and compare your result with a release, which removes the need to trust the download at all.

Make the release directory from your own build:

```sh
pnpm --filter @xmrswap/deploy run release
```

Expected output (your numbers will differ):

```text
wrote <repository>/deploy/release/SHA256SUMS: 7 files
sha256 of the list itself: 809c2427025159cd14b37d699b877a453cc4c3c903ab3fd2facb23980581a358
```

If your "sha256 of the list itself" equals the published one, your build is byte-for-byte the published build.

How far to rely on this: on the machine where this was written, building the page twice from the same source and the same compiled WebAssembly gave identical files. Whether the WebAssembly itself (compiled from Rust) comes out identical on a different machine or operating system **has not been tested**. If your value differs from the published one, compare the lists line by line: a difference only in the `.wasm` file and the files that name it points to the Rust build, not to tampering, but you cannot tell the two apart from the checksum alone. In that case use the published release and verify it with the published checksum.

The build command itself. Not run in this form on the machine where this was written (there the page was built into a scratch directory so as not to disturb other work):

```sh not-run
pnpm --filter @xmrswap/web build
```

## Checking the program id and contract address

The page and the relay act on one Solana program and one Ethereum contract. The release pins both. Three places show them; all three must agree with each other **and with the published values**.

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

2. What a downloaded release pins: the `programId` and `contract` lines of `release.json` in the release directory. That file is covered by the checksums.

3. What the running page uses: the Status page (`http://127.0.0.1:8780/#/status`) shows "Program id" and "Ethereum contract" under "This browser", and the Settings page shows them under "Program and contract". The status command compares the page's value with the pinned one:

   ```text
   ok    Program id is the one this release pins
         5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u. Compare it with the published id yourself; see "Verifying the download".
   ```

   If it prints `warn  Program id differs from the one this release pins`, stop: the settings file or the environment overrides the program id. Remove `program_id` from `deploy/xmrswap.toml` and unset `RELAY_PROGRAM_ID`.

Compare the value with the one the project publishes. Use at least two independent sources (for example the project's announcement and a block explorer page for the program), and compare the whole string, not just the first and last characters.

If you saved settings in the page earlier, the browser's saved program id and contract address take precedence over the bundle's. After upgrading to a release that pins new values, check the Settings page.

## Checking the contracts' upgrade status

The Status page has a line for each chain: "still upgradable", "immutable", or "upgrade status unknown". Until it says "immutable", the project owner can change the contract. "Unknown" means the page could not read it; treat that as upgradable.
