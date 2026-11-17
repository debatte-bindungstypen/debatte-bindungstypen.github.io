// Relay ("TURN") server settings.
//
// Phones on the same Wi-Fi as the presenter's laptop can usually talk to it directly.
// Phones on mobile data or on university Wi-Fi usually can't. They need a relay
// server that passes the (tiny) data through. Free public relays no longer exist,
// so fill in ONE of the two options below. Both have free plans.
//
// Note: whatever you put here is visible to anyone who opens the website. Worst case,
// someone else uses your free relay allowance. Use a free account, not a paid one.

export const RELAY = {
  // Option 1 (recommended) — Metered "Open Relay": free, 20 GB/month, also works
  // through strict firewalls (ports 80 and 443).
  //   1. Sign up: https://www.metered.ca/tools/openrelay/
  //   2. In the dashboard, find your app name (the part before ".metered.live")
  //      and your API key, and paste them here.
  meteredApp: '', // e.g. 'debatte'  (from debatte.metered.live)
  meteredApiKey: '', // e.g. 'a1b2c3d4...'

  // Option 2 — any TURN server with a fixed username/password, e.g. ExpressTURN
  // (free, 1000 GB/month, but only port 3478 on the free plan).
  iceServers: [
    // { urls: 'turn:relay1.expressturn.com:3478', username: '…', credential: '…' },
  ],
};
