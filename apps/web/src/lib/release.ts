/**
 * What the serving bundle says about itself (`GET /release.json`, SPEC 11.5 and deploy's E11).
 * It is the server describing its own files: it tells the user which build the files claim to
 * be and how to check, never what to trust. The page says "verified" only about what it checked
 * itself (the deployed program's hash against the build this page expects).
 */
export interface ServedRelease {
  format: 'xmrswap-served/1';
  ui: { tree_hash: string; files: number; bytes: number };
  recorded: boolean;
  release: {
    version: string;
    status: 'development-snapshot' | 'release';
    commit: string;
    commit_time?: string;
    program_id: string;
    contract: string | null;
    chain_id: number | null;
    web_tree_hash: string;
    web_cid?: string;
    program_executable_hash: string;
    program_hash_source: 'docker' | 'local';
    onchain_deployed?: boolean;
  } | null;
}

/** Parse the served record. `null` for anything that is not the expected shape. */
export function parseServedRelease(j: unknown): ServedRelease | null {
  const o = j as ServedRelease;
  if (typeof o !== 'object' || o === null || o.format !== 'xmrswap-served/1') return null;
  if (typeof o.ui !== 'object' || o.ui === null || !/^[0-9a-f]{64}$/.test(String(o.ui.tree_hash))) return null;
  if (o.release !== null && (typeof o.release !== 'object' || typeof o.release.version !== 'string' || typeof o.release.commit !== 'string' || typeof o.release.program_id !== 'string')) return null;
  return o;
}

/** The record next to the page, or `null` when the bundle provides none (a plain static host). Same origin only. */
export async function fetchServedRelease(fetchFn: typeof fetch = fetch): Promise<ServedRelease | null> {
  try {
    const res = await fetchFn(new URL('./release.json', location.href).toString(), { cache: 'no-store' });
    if (!res.ok) return null;
    return parseServedRelease(await res.json());
  } catch {
    return null;
  }
}
