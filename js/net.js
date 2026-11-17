// Picks the realtime transport. Both expose the same HostNet / ClientNet interface.
//  - Firebase (Jackbox-style): everyone talks to a Firebase Realtime Database over
//    normal web traffic. Works on any network. Used when config.js has a databaseURL.
//  - Peer-to-peer (fallback): phones connect straight to the presenter's browser.
//    Only reliable when everyone is on the same Wi-Fi.

import { FIREBASE } from './config.js';
import { HostNet as P2PHostNet, ClientNet as P2PClientNet } from './net-p2p.js';
import { FbHostNet, FbClientNet } from './net-firebase.js';

export const USING_SERVER = !!FIREBASE?.databaseURL;
export const HostNet = USING_SERVER ? FbHostNet : P2PHostNet;
export const ClientNet = USING_SERVER ? FbClientNet : P2PClientNet;
