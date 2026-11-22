/** What the start command prints when no Tor proxy answers. The bundle never starts Tor; it says how the user can. */
export function torGuidance(addr: string): string[] {
  return [
    `Tor: nothing answers as a SOCKS proxy at ${addr}.`,
    '  The UI still works without it: messages to makers fall back to on-chain',
    '  (Solana swaps only; each message costs a transaction fee and who messaged whom is public).',
    '  This command never starts or changes a Tor client. To use the Tor channel, do one of:',
    '    - start the Tor service your system already has (its SOCKS port is normally 127.0.0.1:9050);',
    '    - run your own copy, no root needed:',
    '        tor --SocksPort 127.0.0.1:9050 --DataDirectory "$HOME/.local/share/xmrswap-tor"',
    '    - keep Tor Browser open and set [relay] tor_socks = "127.0.0.1:9150".',
    '  No restart is needed: the relay tries the proxy again on every request.',
  ];
}
