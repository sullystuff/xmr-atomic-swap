export const SUMS_FILE: string;
export function sha256(file: string): Promise<string>;
export function listFiles(dir: string): string[];
export function parseSums(text: string): { hash: string; file: string }[];
export interface TreeEntry {
  path: string;
  sha256: string;
  size: number;
}
export function treeEntries(dir: string): Promise<TreeEntry[]>;
export function listingText(entries: readonly { path: string; sha256: string }[]): string;
export function treeHash(entries: readonly { path: string; sha256: string }[]): string;
export function executableHash(bytes: Uint8Array): string;
