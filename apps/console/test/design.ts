/** The two example files of docs/DESIGN.md, read from the document itself so the tests track it. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const design = readFileSync(resolve(__dirname, '../../../docs/DESIGN.md'), 'utf8');
const blocks = [...design.matchAll(/```toml\n([\s\S]*?)```/g)].map((m) => m[1] as string);
if (blocks.length !== 2) throw new Error(`expected two TOML examples in DESIGN.md, found ${blocks.length}`);

/** "Maker configuration → Example file". */
export const DESIGN_CONFIG_TOML = blocks[0] as string;
/** "Liquidity rebalancing and refills → Example settings". */
export const DESIGN_REBALANCE_TOML = blocks[1] as string;
export const DESIGN_BOTH_TOML = `${DESIGN_CONFIG_TOML}\n${DESIGN_REBALANCE_TOML}`;
