/* global console */

import ircTests from "./irc.js";
import restartTests from "./restarts.js";
import twitchTests from "./twitch.js";
import rateCounterTests from "./rate-counter.js";
import roomTests from "./room.js";

ircTests();
// restartTests(); // Disabled due to misconfiguration?
twitchTests();
rateCounterTests();
roomTests();

export default true;

