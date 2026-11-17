// Connection settings.

// ---------------------------------------------------------------------------
// Firebase Realtime Database (recommended): the big screen and every phone
// connect to Google's servers like a normal website, Jackbox-style, so it works
// on mobile data and any Wi-Fi. Free plan: up to 100 people at the same time.
// Setup steps: see README.md → "Set up Firebase".
//
// Paste the database URL shown at the top of the Realtime Database "Data" tab,
// e.g. 'https://debatte-1234-default-rtdb.europe-west1.firebasedatabase.app'
// ---------------------------------------------------------------------------
export const FIREBASE = {
  databaseURL: 'https://debatte-aad53-default-rtdb.europe-west1.firebasedatabase.app',
};

// ---------------------------------------------------------------------------
// Fallback, only used while FIREBASE.databaseURL above is empty: phones connect
// straight to the presenter's browser (peer-to-peer). Without a relay ("TURN")
// server this only works for phones on the same Wi-Fi as the presenter.
// You can ignore this section once Firebase is set up.
// ---------------------------------------------------------------------------
export const RELAY = {
  // Metered "Open Relay" (free account): https://www.metered.ca/tools/openrelay/
  meteredApp: '', // e.g. 'debatte' (from debatte.metered.live)
  meteredApiKey: '',
  // Or any TURN server with a fixed username/password:
  iceServers: [
    // { urls: 'turn:relay1.expressturn.com:3478', username: '…', credential: '…' },
  ],
};
