/* global TMI, $, console */

import api from "./api.js";
import EventsDispatcher from "./events.js";
import irc from "./irc.js";
import logging from "./log.js";
import UserStore from "./users.js";
import util from "./util.js";

var logger = logging._getLogger("room");

// Should be less than session's reconnect timeout so we don't
// complete reconnceting in session prior to all rooms reconnecting
var RECONNECT_TIMEOUT = util.time.seconds(10);

var MAX_JOIN_ATTEMPTS = 3;

var ROOM_CONN_EVENTS = {
  "connection:opened": true,
  "connection:retry": true,
  "connection:failed": true,
  "entered": true,
  "joined": true,
  "enter:retry": true,
  "join:retry": true,
  "enter:failed": true,
  "join:failed": true,
  "exited": true,
  "_room_conn:enter": true,
  "_room_conn:exit": true
};

// TODO: Convert to ES6 Class
var RoomConnection = function (opts) {
  this.ircChannel = irc.channel(opts.name);
  this.name = opts.name;
  this._hasJoinedIrcChannel = false;
  this.room = opts.room;
  this._session = opts.session; // FIXME: remove this argument

  this._resetActiveState();
  this._connection = opts.connection;
  this._connection._addRoomConn(this);
  this._bindConn(this._connection);
};

RoomConnection.prototype.on = function (name, callback, context) {
  var thisArg = ROOM_CONN_EVENTS[name] ? this : this._connection;
  EventsDispatcher.prototype.on.call(thisArg, name, callback, context);
};

RoomConnection.prototype.off = function (name, callback, context) {
  var thisArg = ROOM_CONN_EVENTS[name] ? this : this._connection;
  EventsDispatcher.prototype.off.call(thisArg, name, callback, context);
};

RoomConnection.prototype._trigger = function (name) {
  if (!ROOM_CONN_EVENTS[name]) throw new Error('Add to ROOM_CONN_EVENTS before triggering');
  EventsDispatcher.prototype._trigger.apply(this, arguments);
  if (this.room) {
    EventsDispatcher.prototype._trigger.apply(this.room, arguments);
  }
};

RoomConnection.prototype.enter = function () {
  this._trigger("_room_conn:enter");
  if (!this.isActive) {
    this.isActive = true;
    this._enterTracker.startBenchmark('timing_room_enter');
    if (this._hasJoinedIrcChannel) {
      logger.info("Attempted to enter room " + this.name + " but room has already been " +
                  "entered. Ignoring.");
    } else {
      this._joinIrcChannel();
    }
  } else {
    logger.warning("Attempted to enter room " + this.name + " again. Ignoring.");
  }
};

RoomConnection.prototype.exit = function () {
  this._trigger("_room_conn:exit");
  if (this.isActive) {
    this._resetActiveState();
    logger.info("Leaving room " + this.name + ".");
    this._leaveIrcChannel();
  } else {
    logger.warning("Attempted to leave room " + this.name + " which has not attempted to join. Ignoring.");
  }
};

RoomConnection.prototype._joinIrcChannel = function () {
  if (!this._isAllowedToJoin()) {
    logger.warning("Attempted to enter room " + this.name + " but have already failed " +
      MAX_JOIN_ATTEMPTS + " attempts to enter. Ignoring.");
    return;
  }

  this._enterTracker.set('conn_opened', !this._connection.isActive);

  if (!this._connection.isActive) {
    // Join IRC channel after connection opens
    this._connection.open();
  }

  if (this._connection.isOpen) {
    if (this._isWaitingToRetryJoin()) {
      logger.info("Attempted to enter room " + this.name + " but room is already attempting " +
        "to enter. Ignoring.");
    } else {
      logger.info("Attempting to enter room " + this.name + ".");
      this._attemptJoinIrcChannel();
    }
  } else {
    this._enterTracker.startBenchmark('timing_conn_open_wait');
  }
};

RoomConnection.prototype._attemptJoinIrcChannel = function () {
  this._joinTimeout = setTimeout(util.callback(this._onJoinTimeout, this), util.time.seconds(10));
  this._numJoinAttempts += 1;
  this._connection._send("JOIN " + this.ircChannel);
  this._enterTracker.startBenchmark('timing_irc_join_cmd');
};

RoomConnection.prototype._onConnOpened = function () {
  if (this.isActive) {
    logger.info("Connection connected. Attempting to enter room " + this.name + ".");
    this._enterTracker.endBenchmark('timing_conn_open_wait');
    this._attemptJoinIrcChannel();
  }
  this._trigger("connection:opened");
};

RoomConnection.prototype._onConnOpenRetry = function (info) {
  this._hasJoinedIrcChannel = false;
  if (this._isWaitingToRetryJoin()) {
    this._numJoinAttempts -= 1;
  }
  this._clearJoinTimeouts();
  this._enterTracker.increment('conn_retry_count', 1);
  this._trigger("connection:retry", info);
};

RoomConnection.prototype._onConnOpenFailed = function () {
  this._hasJoinedIrcChannel = false;
  if (this._isWaitingToRetryJoin()) {
    this._numJoinAttempts -= 1;
  }
  this._clearJoinTimeouts();
  this._trigger("connection:failed");
  if (this.isActive) {
    this._enterFailed('conn_failure');
  }
};

RoomConnection.prototype._leaveIrcChannel = function () {
  this._hasJoinedIrcChannel = false;
  if (this._connection) {
    // FIXME: Continue to send PART messages until the room receives a PART message from the server
    this._connection._send("PART " + this.ircChannel);
  }
};

RoomConnection.prototype._resetActiveState = function () {
  this.isActive = false;
  this._clearJoinTimeouts();
  this._numJoinAttempts = 0;
  this._hasEntered = false;
  this._hasEnterFailed = false;
  this._enterTracker = new util.types.Tracker();
};

RoomConnection.prototype._onIrcJoin = function (ircMsg) {
  if (this.isActive) {
    logger.info("Successfully entered room " + this.name + ".");
    this._numJoinAttempts = 1;
    this._clearJoinTimeouts();
    if (!this._hasEntered) {
      this._hasEntered = true;
      this._enterTracker.endBenchmark('timing_room_enter');
      this._enterTracker.endBenchmark('timing_irc_join_cmd');
      var trackingData = this._enterTracker.data();
      this._trigger("entered", trackingData);
      this._trigger("joined", trackingData); // FIXME: delete if unused
    }
  } else {
    // Somehow we joined when we weren't trying to... maybe a late joined event after a join:timeout?
    logger.warning("Entered room " + this.name + " unexpectedly. Exiting.");
    this._leaveIrcChannel();
  }
};

RoomConnection.prototype._onJoinTimeout = function () {
  this._clearJoinTimeouts();
  if (this._isAllowedToJoin()) {
    var retryDelay = util.time.seconds(Math.pow(2, this._numJoinAttempts));
    logger.warning("Enter attempt for room " + this.name + " timed out. Attempting to enter again " +
                    "in " + (retryDelay / 1000) + " seconds.");
    this._joinRetryTimeout = setTimeout(util.callback(this._onJoinRetryTimeout, this), retryDelay);
    this._trigger("enter:retry", {
      delay: retryDelay
    });
    this._trigger("join:retry", {
      delay: retryDelay
    });
  } else {
    logger.critical("All " + MAX_JOIN_ATTEMPTS + " attempts to enter room " + this.name + " failed. " +
      "No more attempts will be made.");
    this._enterFailed('irc_join_failed');
  }
};

RoomConnection.prototype._enterFailed = function (reason) {
  if (!this._hasEnterFailed) {
    logger.info("Failed to enter room due to " + reason);
    this._hasEnterFailed = true;
    this._enterTracker.set(reason, true);
    var trackingData = this._enterTracker.data();
    this._trigger("enter:failed", trackingData);
    this._trigger("join:failed", trackingData); // FIXME: delete if unused
  }
};

RoomConnection.prototype._bindConn = function (conn) {
  if (!conn) return;

  conn.on("message", this._onIrcMessage, this);
  conn.on("opened", this._onConnOpened, this);
  conn.on("open:retry", this._onConnOpenRetry, this);
  conn.on("open:failed", this._onConnOpenFailed, this);
};

RoomConnection.prototype._unbindConn = function (conn) {
  if (!conn) return;

  conn.off("message", this._onIrcMessage, this);
  conn.off("opened", this._onConnOpened, this);
  conn.off("open:retry", this._onConnOpenRetry, this);
  conn.off("open:failed", this._onConnOpenFailed, this);
};

RoomConnection.prototype._send = function (msg) {
  this._connection._send(msg);
};

RoomConnection.prototype.destroy = function () {
  this._unbindConn(this._connection);
};

RoomConnection.prototype._onIrcMessage = function (ircMsg) {
  if (ircMsg.target != this.ircChannel) return;

  switch (ircMsg.command) {
  case "JOIN":
    this._onIrcJoin(ircMsg);
    break;
  case "PART":
    if (ircMsg.sender === this._session.nickname) {
      this._resetActiveState();
      this._trigger("exited");
    }
    break;
  default:
    logger.info("RoomConnection " + this.name + " ignoring IRC command " + ircMsg.command + ".");
  }
};

RoomConnection.prototype._onJoinRetryTimeout = function () {
  this._clearJoinTimeouts();
  this._attemptJoinIrcChannel();
};

RoomConnection.prototype._isWaitingToRetryJoin = function () {
  return this._joinTimeout !== null || this._joinRetryTimeout !== null;
};

RoomConnection.prototype._isAllowedToJoin = function () {
  return this._numJoinAttempts <= MAX_JOIN_ATTEMPTS;
};

RoomConnection.prototype._clearJoinTimeouts = function () {
  clearTimeout(this._joinTimeout);
  this._joinTimeout = null;
  clearTimeout(this._joinRetryTimeout);
  this._joinRetryTimeout = null;
};

// TODO: Convert to ES6 class
/*
  Room instances are the interface exposed to clients for a room. Note that all RoomConnection's events are triggered on the Room.

  RoomConnection is responsible for the logic around entering (with retries) and exiting the room, and triggers all its events on the Room.
  */
var Room = function (opts) {
  opts = opts || {};
  this._opts = opts;

  this.ircChannel = irc.channel(opts.name);

  if (!opts.session) throw new Error("Required option for Room constructor: session");
  this.session = opts.session;

  this.displayName = opts.displayName;
  this.name = opts.name;
  this.isGroupRoom = Room.isGroupRoomName(this.name);
  this.ownerId = opts.ownerId;
  this.publicInvitesEnabled = opts.publicInvitesEnabled;

  this._chattersListUrl = opts.chattersListUrl;

  this._roomUserLabels = new util.types.SetStore();

  this._roomUserBadges = [];

  this.on("connection:retry", this._onConnRetry, this);
  this.on("entered", this._onEntered, this);

  this._setRoomConn(new RoomConnection({
    connection: opts.connection,
    name: this.name,
    session: this.session
  }));
};

Room.prototype = new EventsDispatcher();

Room.prototype.destroy = function () {
  this._roomConn.destroy();
};

Room.prototype._getConnection = function () {
  return this._roomConn._connection;
};

Room.isGroupRoomName = function (name) {
  return name.charAt(0) === '_';
};

Room.prototype.enter = function () {
  this._roomConn.enter();
};

Room.prototype.exit = function () {
  this._roomConn.exit();
};

Room.prototype.invite = function (username) {
  var deferred = $.Deferred();

  this.session._depotApi.post('/room_memberships', {
    irc_channel: this.name,
    username: username
  }).done(function () {
    deferred.resolve();
  }).fail(api.chatdepot.fail(deferred));

  return deferred;
};

Room.prototype.acceptInvite = function () {
  var deferred = $.Deferred(),
      self = this;

  this.session._depotApi.put('/room_memberships/' + this.name + '/' + this.userId, {
    is_confirmed: 1
  }).done(function () {
    self.acceptedInvite = true;
    deferred.resolve();
  }).fail(api.chatdepot.fail(deferred));

  return deferred;
};

Room.prototype.rejectInvite = function () {
  var deferred = $.Deferred(),
      self = this;

  this.session._depotApi.del('/room_memberships/' + this.name + '/' + this.userId).done(function () {
    delete self.session._invited[self.name];
    self.session._rememberDeleted(self.name);
    self.acceptedInvite = false;
    deferred.resolve();
    self.session._onListRoomsChanged();
  }).fail(api.chatdepot.fail(deferred));

  return deferred;
};

Room.prototype.setPublicInvitesEnabled = function (enabled) {
  var deferred = $.Deferred(),
      self = this;

  this.session._depotApi.put('/rooms/' + this.name, {
    display_name: self.displayName,
    public_invites_enabled: enabled ? '1' : '0'
  }).done(function () {
    self.publicInvitesEnabled = enabled;
    deferred.resolve();
  }).fail(api.chatdepot.fail(deferred));

  return deferred;
};

Room.prototype.del = function () {
  var deferred = $.Deferred(),
      self = this;

  self.session._depotApi.del('/rooms/' + self.name).done(function () {
    self.session._rememberDeleted(self.name);
    setTimeout(util.callback(self.session._onListRoomsChanged, self.session), 0);
    deferred.resolve();
  }).fail(api.chatdepot.fail(deferred));

  return deferred;
};

Room.prototype.list = function () {
  if (this._chattersListUrl) {
    return $.ajax({
      url: this._chattersListUrl,
      cache: false,
      dataType: 'jsonp',
      timeout: 6000
    });
  } else {
    logger.warning("Attempted to list chatters but chatters list URL hasn't been set. Ignoring.");
    var deferred = $.Deferred();
    deferred.reject();
    return deferred;
  }
};

Room.prototype.hosts = function (options) {
  options = options || {};

  var deferred = $.Deferred(),
      self = this;

  if (!this.isGroupRoom) {
    this.session._tmiApi.get('/hosts', {
      include_logins: options.useDeprecatedResponseFormat ? 1 : undefined,
      target: this.ownerId
    }).done(function (response) {
      if (options.useDeprecatedResponseFormat) {
        deferred.resolve({
          hosts: $.map(response.hosts, function (host) {
            return {host: host.host_login};
          })
        });
      } else {
        deferred.resolve($.map(response.hosts, function (host) {
          return host.host_id;
        }));
      }
    }).fail(api.tmi.fail(deferred));
  } else {
    logger.warning("Attempted to get hosts for group room.");
    deferred.reject();
  }

  return deferred;
};

Room.prototype.hostTarget = function (options) {
  options = options || {};

  var deferred = $.Deferred(),
      self = this;

  if (!this.isGroupRoom) {
    this.session._tmiApi.get('/hosts', {
      include_logins: options.useDeprecatedResponseFormat ? 1 : undefined,
      host: this.ownerId
    }, {cache:false}).done(function (response) {
      if (options.useDeprecatedResponseFormat) {
        deferred.resolve({
          host_target: response.hosts[0].target_login || ""
        });
      } else {
        deferred.resolve(response.hosts[0].target_id);
      }
    }).fail(api.tmi.fail(deferred));
  } else {
    logger.warning("Attempted to fetch host target but group rooms cannot host. Ignoring.");
    deferred.reject();
  }
  return deferred;
};

Room.prototype.recentMessages = function (messageCount) {
  var deferred = $.Deferred();

  // ownerId will always be the ID of the room for now, until we dissociate
  // channels from rooms.
  let params = {};
  if (messageCount) {
    params.count = messageCount;
  }
  this.session._tmiApi.get('/api/rooms/' + this.ownerId + '/recent_messages', params).done(function (response) {
    deferred.resolve(response.messages);
  }, {cache:false}).fail(api.tmi.fail(deferred));

  return deferred;
};

Room.prototype.rename = function (newName) {
  var deferred = $.Deferred();

  this.session._depotApi.put('/rooms', {
    irc_channel: this.name,
    display_name: newName
  }).done(function () {
    deferred.resolve();
  }).fail(api.chatdepot.fail(deferred));

  return deferred;
};

Room.prototype.getLabels = function (username) {
  var specials = this.session._users.getSpecials(username);
  return util.array.join(
    this.name === username ? ["owner"] : [],
    this._roomUserLabels.get(username),
    specials
  );
};

Room.prototype.getBadges = function (username) {
  return util.convertBadgesTagToOldFormat(this._roomUserBadges[username]);
};

Room.prototype.setBadges = function (username, badges) {
  this._updateUserStateBadges(username, badges);
};

Room.prototype.sendMessage = function (msg) {
  if (!this._roomConn) {
    logger.warning('Attempted to send "' + msg + '" prior to configuring room connection. Ignoring.');
    return;
  }

  var command = msg.split(' ', 1)[0],
      action = command === '/me',
      self = this,
      target, message,
      tagString = irc.constructTags({'sent-ts': Date.now()});

  message = action ? msg.substr(4) : msg;

  var msgObject = {
    from: self.session.nickname,
    message: message,
    style: action ? 'action' : undefined,
    date: new Date(),
    tags: {
      'display-name': self.session.getDisplayName(self.session.nickname),
      badges: self.getBadges(self.session.nickname)
    },
    labels: self.getLabels(self.session.nickname)
  };

  self._trigger('message-sent', msgObject);

  var sendMessage = function () {
    self._trigger('message', msgObject);

    self._roomConn._send("@" + tagString + " " + "PRIVMSG" + " " + self.ircChannel + " :" + msg);
  };

  var ignoreUser = function () {
    target = msg.split(' ')[1];
    if (target) {
      self.ignoreUser(target);
    }
    return;
  };

  var unignoreUser = function () {
    target = msg.split(' ')[1];
    if (target) {
      self.unignoreUser(target);
    }
  };

  var runCommercial = function () {
    var time = 0;
    var split = msg.split(' ');
    if (split.length > 1) {
      time = split[1];
    }
    self.runCommercial(time);
  };

  var sendCommand = function () {
    self._roomConn._send("PRIVMSG " + self.ircChannel + " :" + msg);
  };
  command = command.toLowerCase();
  if (command === '/me' || command.charAt(0) !== '/') {
    sendMessage();
  } else if (command === '/ignore') {
    ignoreUser();
  } else if (command === '/unignore') {
    unignoreUser();
  } else if (command === '/commercial') {
    runCommercial();
  } else {
    sendCommand();
  }
};

Room.prototype.runCommercial = function (time) {
  var self = this;
  time = parseInt(time);
  if (!isNaN(time)) {
    this.session.runCommercial(this.ircChannel.substring(1), time)
      .done(function () {
        self._showAdminMessage("Initiating commercial break. Please keep in mind that your stream is still live and not everyone will get a commercial!");
      }).fail(function () {
        self._showAdminMessage("Failed to start commercial.");
      });
  } else {
    self._showAdminMessage("That's an invalid commercial length!");
  }
};

Room.prototype.ignoreUser = function (username, reason) {
  var self = this;
  this.session.ignoreUser(username, reason)
  .done(function () {
    self._showAdminMessage("User successfully ignored");
  }).fail(function () {
    self._showAdminMessage("There was a problem ignoring that user");
  });
};

Room.prototype.unignoreUser = function (username) {
  var self = this;
  this.session.unignoreUser(username)
  .done(function () {
    self._showAdminMessage("User successfully unignored");
  }).fail(function () {
    self._showAdminMessage("There was a problem unignoring that user");
  });
};

Room.prototype.clearChat = function (username) {
  if (username) {
    this.sendMessage("/clear " + username);
  } else {
    this.sendMessage("/clear");
  }
};

Room.prototype.showCommercial = function (seconds) {
  this.sendMessage("/commercial " + seconds);
};

Room.prototype.banUser = function (username) {
  this.sendMessage("/ban " + username);
};

Room.prototype.unbanUser = function (username) {
  this.sendMessage("/unban " + username);
};

Room.prototype.modUser = function (username) {
  this.sendMessage("/mod " + username);
};

Room.prototype.unmodUser = function (username) {
  this.sendMessage("/unmod " + username);
};

Room.prototype.timeoutUser = function (username) {
  this.sendMessage("/timeout " + username);
};

Room.prototype.startSlowMode = function (seconds) {
  seconds = seconds || '';
  this.sendMessage("/slow " + seconds);
};

Room.prototype.stopSlowMode = function () {
  this.sendMessage("/slowoff");
};

Room.prototype.startSubscribersMode = function () {
  this.sendMessage("/subscribers");
};

Room.prototype.stopSubscribersMode = function () {
  this.sendMessage("/subscribersoff");
};

// "Duration" is either an integer, in minutes, or an english-like string, such
// as "30 minutes" or "1 day 12 hours"
Room.prototype.setFollowersMode = function (duration) {
  if (duration !== undefined) {
    this.sendMessage("/followers " + duration);
  } else {
    this.sendMessage("/followers");
  }
};

Room.prototype.stopFollowersMode = function () {
  this.sendMessage("/followersoff");
};


Room.prototype._setRoomConn = function (roomConn) {
  if (this._roomConn) {
    this._unbindRoomConn(this._roomConn);
    this._roomConn.room = undefined;
  }
  this._bindRoomConn(roomConn);
  roomConn.room = this;
  this._roomConn = roomConn;
};

Room.prototype._showAdminMessage = function (message) {
  this._trigger('message', {
    style: "admin",
    from: "jtv",
    message: message,
    date: new Date()
  });
};

Room.prototype._hasModPrivileges = function () {
  var labels = this.getLabels(this.session.nickname);
  return labels.indexOf("owner") >= 0 ||
    labels.indexOf("staff") >= 0 ||
    labels.indexOf("admin") >= 0 ||
    labels.indexOf("global_mod") >= 0 ||
    labels.indexOf("mod") >= 0;
};

Room.prototype._bindRoomConn = function (roomConn) {
  if (!roomConn) return;

  roomConn.on("clearchat", this._onClearChat, this);
  roomConn.on("flashtimeout", this._onFlashTimedOut, this);
  roomConn.on("hosttarget", this._onHostTargetUpdate, this);
  roomConn.on("message", this._onIrcMessage, this);
  roomConn.on("privmsg", this._onIrcPrivmsg, this);
  roomConn.on("usernotice", this._onUserNotice, this);
  roomConn.on("reconnecting", this._onReconnecting, this);
  roomConn.on("roomban", this._onRoomBan, this);
  roomConn.on("roomchanged", this._onRoomChanged, this);
  roomConn.on("roomdeleted", this._onRoomDeleted, this);
  roomConn.on("specialuser", this._onUserSpecialAdded, this);
  roomConn.on("userstate", this._onUserStateUpdated, this);
  roomConn.on("notice", this._onNotice, this);
  roomConn.on("roomstate", this._onRoomState, this);
};

Room.prototype._unbindRoomConn = function (roomConn) {
  if (!roomConn) return;

  roomConn.off("clearchat", this._onClearChat, this);
  roomConn.off("flashtimeout", this._onFlashTimedOut, this);
  roomConn.off("hosttarget", this._onHostTargetUpdate, this);
  roomConn.off("message", this._onIrcMessage, this);
  roomConn.off("privmsg", this._onIrcPrivmsg, this);
  roomConn.off("usernotice", this._onUserNotice, this);
  roomConn.off("reconnecting", this._onReconnecting, this);
  roomConn.off("roomban", this._onRoomBan, this);
  roomConn.off("roomchanged", this._onRoomChanged, this);
  roomConn.off("roomdeleted", this._onRoomDeleted, this);
  roomConn.off("specialuser", this._onUserSpecialAdded, this);
  roomConn.off("userstate", this._onUserStateUpdated, this);
  roomConn.off("notice", this._onNotice, this);
  roomConn.off("roomstate", this._onRoomState, this);
};

Room.prototype._onConnRetry = function (info) {
  this._showAdminMessage("Sorry, we were unable to connect to chat. Reconnecting in " + (info.delay / 1000) + " seconds.");
};

Room.prototype._onFlashTimedOut = function () {
  this._trigger("flashtimedout");
};

Room.prototype._onNotice = function (ircMsg) {
  if (ircMsg.target !== this.ircChannel && ircMsg.target != "#jtv") return; // #jtv is used for whispers
  this._trigger("notice", {
    msgId: ircMsg.tags["msg-id"],
    message: ircMsg.message
  });
};

Room.prototype._onHostTargetUpdate = function (ircChannel, hostTarget, numViewers, recentlyJoined) {
  if (ircChannel != this.ircChannel) return;

  var infoMsg = 'Received host target update for ' + ircChannel + '. ';
  if (hostTarget !== null) {
    infoMsg += 'Adding host target: ' + hostTarget;
  } else {
    infoMsg += 'Removing host target.';
  }
  logger.info(infoMsg);

  this._trigger('host_target', {
    hostTarget: hostTarget,
    numViewers: numViewers,
    recentlyJoined: recentlyJoined
  });
};

Room.prototype._onIrcMessage = function (ircMsg) {
  if (ircMsg.target != this.ircChannel) return;

  switch (ircMsg.command) {
    case "PRIVMSG":
      this._onIrcPrivmsg(ircMsg);
      break;
    default:
      logger.info("Room " + this.name + " ignoring IRC command " + ircMsg.command + ".");
  }
};

Room.prototype._onIrcMessageDeduped = function (ircMsg) {
  if (ircMsg.sender === this.session.nickname) return;

  if (!this._dedupeSeen) this._dedupeSeen = {};

  var id = ircMsg.sender + '|' + ircMsg.message; // FIXME: allow for legitimate duplicate messages?
  if (!this._dedupeSeen[id]) {
    this._dedupeSeen[id] = true;
    this._onIrcMessage(ircMsg);
  }
};

Room.prototype._onIrcPrivmsg = function (ircMsg) {
  if (irc.isChannel(ircMsg.target) && ircMsg.target != this.ircChannel) return;

  switch (ircMsg.style) {
  case "admin":
    if (ircMsg.message.match(/^This room is now in slow mode. You may send messages every \d+ seconds$/)) {
      this._trigger('slow');
    } else if (ircMsg.message.match(/^This room is no longer in slow mode.$/)) {
      this._trigger('slowoff');
    }
    break;
  case "notification":
  case "action":
    // do nothing
    break;
  default:
    this._updateUserStateAndSession(ircMsg.sender, ircMsg.tags);
    break;
  }

  if (this._shouldShowChatMessage(ircMsg.sender)) {
    this._trigger('message', {
      style: ircMsg.style,
      from: ircMsg.sender,
      message: ircMsg.message,
      tags: ircMsg.tags,
      date: new Date()
    });
  } else {
    logger.warning('Ignored message from ' + ircMsg.sender);
  }
};

Room.prototype._updateUserStateAndSession = function (sender, tags) {
  this._updateUserState(sender, tags);
  this.session._updateUserState(sender, tags);
};

Room.prototype._onUserNotice = function (ircMsg) {
  if (ircMsg.target != this.ircChannel) { return; }

  this._updateUserStateAndSession(ircMsg.sender, ircMsg.tags);

  if (this._shouldShowChatMessage(ircMsg.sender)) {
    this._trigger('usernotice', {
      style: ircMsg.style,
      from: ircMsg.sender,
      message: ircMsg.message,
      tags: ircMsg.tags,
      date: new Date()
    });
  } else {
    logger.warning('Ignored message from ' + ircMsg.sender);
  }
};

Room.prototype._shouldShowChatMessage = function (sender) {
  // chat messages should appear always if you have mod privileges for this room
  return this._hasModPrivileges() || !this.session.isIgnored(sender);
};

Room.prototype._onRoomState = function (ircMsg) {
  if (ircMsg.target != this.ircChannel) return;

  this._trigger('roomstate', {
    tags: ircMsg.tags
  });
};

Room.prototype._onReconnecting = function (newConn) {
  logger.info("Room" + this.name + "reconnecting");

  var self = this;

  var oldRoomConn = this._roomConn;
  var newRoomConn = new RoomConnection({
    connection: newConn,
    name: self.name,
    session: self.session
  });

  if (!oldRoomConn.isActive) {
    self._setRoomConn(newRoomConn);
    return;
  }

  var syncEnter = function () { newRoomConn.enter(); };
  var syncExit = function () { newRoomConn.exit(); };
  self.on('_room_conn:enter', syncEnter);
  self.on('_room_conn:exit', syncExit);

  var unbind = function () {
    self.off('_room_conn:enter', syncEnter);
    self.off('_room_conn:exit', syncExit);
    newRoomConn.off('exited', onExited);
    newRoomConn.off('entered', onEntered);
    newRoomConn.off('enter:failed', onEnterFailed);
  };

  var onExited = function () {
    unbind();
    self._setRoomConn(newRoomConn);
  };
  newRoomConn.on('exited', onExited);

  var onEntered = function () {
    unbind();
    // Execute just after 'entered' callbacks, so remaining 'entered'
    // callbacks don't assume we already switched.
    setTimeout(function () {
      self.switchRoomConn(newRoomConn);
    }, 0);
  };
  newRoomConn.on('entered', onEntered);

  var onEnterFailed = function (trackingData) {
    unbind();
    logger.critical('Enter failed during reconnect.');
    self._setRoomConn(newRoomConn);
    oldRoomConn.exit();
    self._trigger('exited');
  };
  newRoomConn.on('enter:failed', onEnterFailed);

  newRoomConn.enter();
};

Room.prototype.switchRoomConn = function (newRoomConn) {
  var self = this;

  var oldRoomConn = self._roomConn;
  oldRoomConn.room = undefined;
  newRoomConn.room = self;

  oldRoomConn.off("message", self._onIrcMessage, self);
  oldRoomConn.on("message", self._onIrcMessageDeduped, self);
  newRoomConn.on("message", self._onIrcMessageDeduped, self);

  setTimeout(function () {
    oldRoomConn.exit();

    setTimeout(function () {
      self._setRoomConn(newRoomConn);
      oldRoomConn.on("message", self._onIrcMessage, self);
      oldRoomConn.off("message", self._onIrcMessageDeduped, self);
      newRoomConn.off("message", self._onIrcMessageDeduped, self);
      self._dedupeSeen = undefined;
    }, RECONNECT_TIMEOUT / 2);
  }, RECONNECT_TIMEOUT / 2);
};

Room.prototype.fetchHistory = function (messageCount) {
  return this.recentMessages(messageCount).then((messages) => {
    this._addHistoricalMessages(messages);
    return messages.length;
  });
};

Room.prototype._onRoomBan = function (ircChannel) {
  if (ircChannel != this.ircChannel) return;
  this.exit();
  this._trigger('banned');
};

Room.prototype._onRoomChanged = function (ircChannel) {
  if (ircChannel != this.ircChannel) return;
  this._isDirty = true;
  this._trigger('changed');
};

Room.prototype._onRoomDeleted = function (ircChannel) {
  if (ircChannel != this.ircChannel) return;
  this.exit();
  this._trigger('deleted');
};

Room.prototype._onUserSpecialAdded = function (username, special) {
  if (special === 'subscriber') {
    this._roomUserLabels.add(username, special);
  }
  this._onLabelsChanged(username);
};

Room.prototype._onUserStateUpdated = function (msg) {
  if (msg.target !== this.ircChannel) return;
  this._updateUserState(this.session.nickname, msg.tags);
};

Room.prototype._updateUserState = function (user, tags) {
  this._updateUserStateBadges(user, tags._badges);
  this._updateUserStateLabel(user, tags, "subscriber");

  // mod is a room-dependent user type. global user types (staff, turbo, etc)
  // are handled by the session user store
  this._updateUserStateLabel(user, tags, "mod");
};

Room.prototype._updateUserStateLabel = function (user, tags, label) {
  var labels = this._roomUserLabels.get(user);
  var hasStateChanged = tags[label] !== labels.indexOf(label) > -1;

  if (hasStateChanged) {
    if (tags[label]) {
      this._roomUserLabels.add(user, label);
    } else {
      this._roomUserLabels.remove(user, label);
    }
    this._onLabelsChanged(user);
  }
};

Room.prototype._updateUserStateBadges = function (user, newBadges=[]) {
  var existingBadges = this._roomUserBadges[user] || [];

  // Do a deep equals comparison of the existing badges and the new badges.
  // If they're equal, then don't fire a badges changed event.
  var stateHasChanged = newBadges.length !== existingBadges.length;
  if (!stateHasChanged) {
    for (var i = 0; i < existingBadges.length; i++) {
      var existingBadge = existingBadges[i];
      var newBadge = newBadges[i];
      if (existingBadge.id !== newBadge.id || existingBadge.version !== newBadge.version) {
        stateHasChanged = true;
        break;
      }
    }
  }

  if (stateHasChanged) {
    this._roomUserBadges[user] = newBadges;
    this._onBadgesChanged(user);
  }
};

Room.prototype._onLabelsChanged = function (username) {
  this._trigger('labelschanged', username);
};

Room.prototype._onBadgesChanged = function (username) {
  this._trigger('badgeschanged', username);
};

Room.prototype._onClearChat = function (ircChannel, username, tags) {
  if (ircChannel != this.ircChannel) return;
  this._trigger('clearchat', username, tags);
};

Room.prototype._addHistoricalMessages = function (messages) {
  let self = this;
  let welcomeSent = false;
  let sentStates = [];

  messages.reverse().forEach(function (msg) {
    let ircMsg = irc.parseMessage(msg);

    // We send historical messages in reverse order, but we track user state based
    // on the newest message. So we only need to send one update per user, based
    // on the "last" message, aka the first one we encounter.
    if (sentStates.indexOf(ircMsg.sender) === -1) {
      sentStates.push(ircMsg.sender);
      self._updateUserStateAndSession(ircMsg.sender, ircMsg.tags);
    }

    if (self._shouldShowChatMessage(ircMsg.sender)) {
      let historicalMessage = {
        style: ircMsg.style,
        from: ircMsg.sender,
        message: ircMsg.message,
        tags: ircMsg.tags
      };
      if (ircMsg.hasOwnProperty('tags') && ircMsg.tags.hasOwnProperty('tmi-sent-ts')) {
        historicalMessage.date = new Date(parseInt(ircMsg.tags['tmi-sent-ts'], 10));
      }
      self._trigger('historical-message', historicalMessage);
    }
  });
};

Room.prototype._onEntered = function () {
  this._showAdminMessage("Welcome to the chat room!");
};

export default Room;
