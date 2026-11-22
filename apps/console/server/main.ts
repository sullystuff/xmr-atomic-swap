/** `pnpm --filter @xmrswap/console mock`: run the mock daemon alone on loopback. */
import { MOCK_TOKEN, startMockServer } from './mock-server.js';

const port = Number(process.env.MOCK_DAEMON_PORT ?? 7171);
const server = await startMockServer({ port });
console.log(`mock daemon listening on ${server.url}`);
console.log(`bearer token: ${MOCK_TOKEN}`);
