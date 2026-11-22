# Fixtures

**Every file here is hand-written.** None was recorded from a live service: no API key was used
and no venue was contacted while this package was built.

| File | Written from | Confidence |
| --- | --- | --- |
| `changenow.json` | ChangeNOW v2 public docs (endpoints and parameters in `docs/research/local-assets.md` section 5); response field names from the documented examples | Endpoints confirmed by the research; response fields not checked against a live response |
| `fixedfloat.json` | FixedFloat public API page | Same |
| `stealthex.json` | StealthEX v4 API reference | Same, and XMR on the API currency list is unconfirmed |
| `houdiniswap.json` | HoudiniSwap partner API v2 description | Lowest: token identifiers and several field names are assumptions; XMR payout is unconfirmed |
| `kraken.json` | Kraken REST documentation | Signature checked against Kraken's published worked example; responses not checked live |
| `jupiter.json` | Jupiter `swap/v1` quote response shape | Field names as used by the operator's working code, per the research |

Bridge account data, heartbeat pages and events in the bridge tests are built in the test code
from the layout table in `src/bridge/program.ts` (see `BRIDGE-ASSUMPTIONS.md`), not captured
from chain.

When a service is first enabled with a real key, record real responses (with the key and any
addresses removed) next to these and switch the tests over.
