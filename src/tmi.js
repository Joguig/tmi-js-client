/* global $, swfobject */

import Connection from "./conn.js";
import EventsDispatcher from "./events";
import irc from "./irc.js";
import logging from "./log.js";
import util from "./util.js";
import SessionManager from "./session.js";
import TMIWebSocket from "./WebSocket.js";

var logger = logging._getLogger("TMI");

class TMI extends EventsDispatcher {
  constructor () {
    super();
    this._logger = logger;
    this.VERSION = 3;
    this._sessions = [];
  }

  /*
    Creates a TMI session for the specified user. A session manages one or more connections
    to TMI clusters but hides the nitty-gritty details of connection/cluster details from
    the user.

    Options:
    - username: username for the user (both username/oauthToken token are required to chat)
    - oauthToken: oauth token for the user (both username/oauthToken are required to chat)
  */
  createSession (opts) {
    var nickname = "justinfan" + util.randomInt(999999);
    var password = "blah";

    if (opts.username && opts.oauthToken) {
      // TODO: JTV can't use this unless they switch to using oauth tokens
      nickname = opts.username;
      password = "oauth:" + opts.oauthToken;
    }

    var session = new SessionManager({
      nickname: nickname,
      userId: opts.userId,
      password: password,
      oauthToken: opts.oauthToken,
      apiHostport: opts.apiHostport
    });

    this._sessions.push(session);
    return session;
  }

  /*
    Return the average socket messages/sec for the past 60s for all sockets created by TMI.
    This can be used to correlate chat load with other performance issues.
  */
  getMessageRate () {
    var rate = 0;
    $.each(this._sessions, function (_, session) {
      rate += session.getMessageRate();
    });
    return rate;
  }

  usingWebSockets () {
    for (var i = 0; i < this._sessions.length; i++) {
      if (this._sessions[i].isUsingWebSockets()) {
        return true;
      }
    }
    return false;
  }

  _onSessionDestroyed (session) {
    util.array.remove(this._sessions, session);
  }

}

export default new TMI();
