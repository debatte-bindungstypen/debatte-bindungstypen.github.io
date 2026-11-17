# Debate Floor

A live "take a side" vote for presentations. The audience joins on their phones by QR code or room code and drags a dot to one side of a virtual floor. The big screen shows where everyone stands, records how the room shifts, replays it, and ends with results and awards.

The website is static files on **GitHub Pages**. The live connection goes through a free **Firebase Realtime Database** (Google), the same way Jackbox works: the big screen and every phone connect to one server, like opening any website. So it works on mobile data, eduroam, guest Wi-Fi, and anywhere else a website loads.

## How it works

- Whoever opens `host.html` creates a room. That's the presenter's laptop. Nothing runs at your home.
- Phones write their name and position into the room in the database, at most about 7 times per second while dragging.
- The big screen reads those changes, records the history, and writes back the crowd and the tally once per second.
- The database notices on its own when a phone goes offline. That person's dot stays, faded, and still counts.
- The session is autosaved in the presenter's browser. If the big-screen tab reloads, choose **Resume room**. Phones stay connected the whole time.
- Firebase's free plan (Spark) allows **100 people at the same time** and needs no credit card. A talk with 20 people uses a tiny fraction of it.

## Set up Firebase (once, about 10 minutes)

1. Open [console.firebase.google.com](https://console.firebase.google.com) and sign in with a Google account.
2. **Create a project**, e.g. "debatte". You can switch Google Analytics off.
3. In the left menu, open **Realtime Database** (under *Build* or *Databases*) and click **Create database**:
   - Location: **Belgium (europe-west1)**.
   - Security rules: **Start in locked mode**.
4. Open the **Rules** tab. Replace everything with the contents of [`firebase-rules.json`](firebase-rules.json) and click **Publish**. Each room can be read and written by anyone who knows its code. Nobody can list rooms or touch anything else.
5. Open the **Data** tab and copy the URL at the top, e.g. `https://debatte-1234-default-rtdb.europe-west1.firebasedatabase.app`.
6. Paste it into [`js/config.js`](js/config.js) as `databaseURL`, then upload the files to GitHub.
7. Open `host.html`. The status line should say "Live · room XXXX". Join with a phone on **mobile data** to check it.

The database URL is visible to visitors of the site. That's normal for Firebase, and the rules decide what anyone can do. Old rooms stay in the database. You can delete them under **Data** whenever you like.

Without a `databaseURL`, the site falls back to connecting phones straight to the presenter's laptop (peer-to-peer). That only works when everyone is on the same Wi-Fi. The big screen then shows "no server set up".

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

- **Keep the big-screen tab open** during the talk. You can switch to your slides (Cmd/Alt-Tab), and the vote keeps recording in the background. If the tab is closed, reopen it and choose **Resume room**. Phones can keep voting meanwhile, but moves made while the big screen is closed won't appear in the replay.
- **Audience size:** Firebase's free plan allows 100 simultaneous connections, so about 95 people plus the big screen. For more, switch the Firebase project to the pay-as-you-go plan, which costs practically nothing for one talk.
- **Networks:** with Firebase set up, all traffic is normal web traffic, so it works on any Wi-Fi or mobile data where websites load.
- **Privacy:** names and positions are stored in your Firebase database, in the EU if you picked Belgium. Delete old rooms there after the talk if you like.
- **Testing locally:** run `python3 -m http.server 8765` in this folder and open `http://localhost:8765/host.html`. The QR code points to `localhost`, so real phones can't use it. Deploy to GitHub Pages to test with phones.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Landing page: join with a code, or open the big screen |
| `host.html`, `js/host.js` | Big screen: floor, tally, timeline, replay, results, settings |
| `join.html`, `js/phone.js` | Phone view |
| `js/config.js` | Connection settings: paste your Firebase database URL here |
| `js/net.js` | Picks the connection type: Firebase, or peer-to-peer as a fallback |
| `js/net-firebase.js` | Firebase connection (Jackbox-style, works everywhere) |
| `js/net-p2p.js` | Peer-to-peer fallback (PeerJS / WebRTC, same Wi-Fi only without a relay) |
| `firebase-rules.json` | Security rules to paste into the Firebase console |
| `js/stats.js` | Replay engine, switches, travel, time per side, awards |
| `js/shared.js` | Shared helpers |
