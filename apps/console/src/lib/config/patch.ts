/** Change a few keys of the saved configuration through the same validate-then-save path as the Configuration page. */
import type { ConfigResponse } from '@xmrswap/protocol/daemon-api';
import { ApiFailure, type DaemonClient } from '../../api/client.js';
import { parseToml, stringifyToml, type Toml } from './toml.js';

export async function patchConfig(client: DaemonClient, mutate: (cfg: Toml) => Toml): Promise<ConfigResponse> {
  const current = await client.call('configGet');
  const toml = stringifyToml(mutate(parseToml(current.toml)));
  const v = await client.call('configValidate', { body: { toml } });
  if (!v.ok) {
    const first = v.errors[0];
    throw new ApiFailure(422, 'invalid_config', first ? `${first.path}: ${first.message}` : 'The change is not valid.');
  }
  return client.call('configPut', { body: { toml, base_revision: current.revision } });
}
