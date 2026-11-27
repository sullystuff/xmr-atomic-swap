/**
 * The IPFS content identifier of a file tree, computed offline: the tree is turned into UnixFS
 * blocks in memory and only the root's CID is kept. No IPFS node is started and nothing is
 * published or fetched.
 *
 * The CID depends on how the tree is chunked, so the parameters are fixed and recorded in every
 * manifest (`CID_PARAMS`): CIDv1, SHA-256, raw leaves, 262,144-byte chunks, balanced layout with
 * at most 174 links per node, files wrapped in one directory. These are the importer's defaults
 * for CIDv1 and correspond to `ipfs add -r --cid-version=1` with kubo's long-standing defaults.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryBlockstore } from 'blockstore-core';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';

export const CID_PARAMS = 'unixfs; cidv1; sha2-256; raw-leaves; chunker=size-262144; layout=balanced-174; wrap-with-directory' as const;

/** The CIDv1 (base32) of the directory holding `files` (relative paths, forward slashes) read from `dir`. */
export async function treeCid(dir: string, files: readonly string[]): Promise<string> {
  // Sorted input, so the result cannot depend on the order the caller listed the files in.
  const sorted = [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const source = sorted.map((file) => ({ path: file, content: new Uint8Array(readFileSync(path.join(dir, file))) }));
  let root: string | null = null;
  for await (const entry of importer(source, new MemoryBlockstore(), {
    cidVersion: 1,
    rawLeaves: true,
    wrapWithDirectory: true,
    chunker: fixedSize({ chunkSize: 262_144 }),
    layout: balanced({ maxChildrenPerNode: 174 }),
  })) {
    if (entry.path === '') root = entry.cid.toString();
  }
  if (root === null) throw new Error('the importer returned no root directory');
  return root;
}
