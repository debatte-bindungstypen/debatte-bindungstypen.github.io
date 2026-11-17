# Debate Floor

A live "take a side" vote for presentations. The audience joins on their phones by QR code or room code and drags a dot to one side of a virtual floor. The big screen shows where everyone stands, records how the room shifts, replays it, and ends with results and awards.

Everything is static files, so it runs on **GitHub Pages**. No server or accounts are needed.

## How it works

- `host.html` (big screen) is the "server". The presenter's browser keeps the session and talks to every phone directly over WebRTC.
- The free [PeerJS](https://peerjs.com) cloud broker only introduces phones to the big screen.
- Phones on the same Wi-Fi as the laptop can usually connect directly. **Phones on mobile data or on university Wi-Fi need a relay ("TURN") server**, set in `js/config.js` (see below).
- Phones send their position about 14 times per second while dragging. The big screen sends back the crowd and the tally once per second.
- Everything is autosaved in the presenter's browser. If the big-screen tab reloads, choose **Resume room**: you get the same code, and phones reconnect by themselves.

## Set up the relay (required for mobile data and university Wi-Fi)

The relays that PeerJS used to provide have been shut down, and there is no free public relay without an account any more. Without a relay, only phones on the same Wi-Fi as the laptop can join. The big screen's status line then says "no relay server".

1. Create a free account for Metered's [Open Relay](https://www.metered.ca/tools/openrelay/). It includes 20 GB a month and works through strict firewalls on ports 80 and 443. A one-hour talk with 150 people uses well under 1 GB.
2. In the Metered dashboard, find your app name (the part before `.metered.live`) and your API key.
3. Put both into `js/config.js` (`meteredApp` and `meteredApiKey`) and upload that file.
4. Test with `join.html?room=CODE&relayonly`. It forces the relay, like a phone on mobile data would need. The big screen then shows "1 phone connected (1 via relay)".

Anything in `config.js` is visible to visitors of the site. At worst, someone uses up your free allowance.

## Publish on GitHub Pages

1. Create a new public repository on GitHub, e.g. `debate-floor`.
2. Upload the contents of this folder (`index.html`, `host.html`, `join.html`, `css/`, `js/`, `.nojekyll`) to the repository root.
3. In the repository, go to **Settings → Pages → Build and deployment**, set **Source: Deploy from a branch**, pick **Branch: `main` / `(root)`**, and save.
4. After about a minute, the site is live at `https://<your-user>.github.io/debate-floor/`.

With the GitHub CLI, from inside this folder:

```bash
git init && git add . && git commit -m "Debate Floor"
gh repo create debate-floor --public --source . --push
gh api -X POST repos/{owner}/debate-floor/pages -f "source[branch]=main" -f "source[path]=/"
```

## On the day

1. On the presentation laptop, open `https://<your-user>.github.io/debate-floor/host.html`. Use Chrome or Edge, and press **F** for fullscreen.
2. Set the question and the two side names in **Settings** (gear icon).
3. The join screen shows the QR code and the room code. Press **Q** to hide or show it.
4. Use **Mark moment** (M) at key points, for example *Before the debate*, *Opening statements* and *Final vote*. The results compare the room at each mark.
5. **Lock voting** (L) freezes everyone, for example for the final count.
6. At the end, use **Replay** (R) to watch the room move at 4–30× speed, then **Results** (S) for awards and a table of every person. Click any name to draw their path on the floor.
7. Use **Save session file** to keep a `.json` copy. **Open session file** replays it later. Use **Export CSV** for spreadsheets.

### Keyboard

| Key | Action |
| --- | --- |
| Q | Join screen |
| M | Mark moment |
| L | Lock / unlock voting |
| R | Replay |
| Space | Play / pause replay |
| S | Results |
| N | Names on / off |
| H | Heatmap on / off |
| F | Fullscreen |
| Esc | Close panels |

## Rehearse first

- **Settings → Add 12 test people** adds people who wander around and change their minds, so you can try the replay and results.
- To simulate several phones on one computer, open more tabs with `join.html?room=CODE&fresh&name=Test1`. `fresh` makes each tab a separate person.
- Before the talk, do a real check on the venue Wi-Fi with 2–3 phones, and use at least one on mobile data.

## Good to know

- **Keep the big-screen tab open** during the talk. You can switch to your slides (Cmd/Alt-Tab), and the vote keeps recording in the background. If the tab is closed, phones wait and reconnect when you reopen it and choose **Resume room**.
- **Audience size:** about 150 phones works comfortably on a normal laptop. Beyond about 200, consider a dedicated realtime backend; only `js/net.js` would need to change.
- **Strict networks:** university Wi-Fi usually blocks devices from talking to each other directly, so phones there go through the relay. The Metered relay also runs on port 443, the normal web port, so it works anywhere websites load.
- **Privacy:** names and positions go only from phones to the presenter's browser. Nothing is stored on a server.
- **Testing locally:** run `python3 -m http.server 8765` in this folder and open `http://localhost:8765/host.html`. The QR code points to `localhost`, so real phones can't use it. Deploy to GitHub Pages to test with phones.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Landing page: join with a code, or open the big screen |
| `host.html`, `js/host.js` | Big screen: floor, tally, timeline, replay, results, settings |
| `join.html`, `js/phone.js` | Phone view |
| `js/config.js` | Relay (TURN) server settings: fill this in |
| `js/net.js` | Realtime layer (PeerJS / WebRTC). Swap this file to change the transport |
| `js/stats.js` | Replay engine, switches, travel, time per side, awards |
| `js/shared.js` | Shared helpers |
