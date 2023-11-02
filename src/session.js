/* global $, TMI, Twitch */

import api from "./api.js";
import Connection from "./conn.js";
import EventsDispatcher from "./events.js";
import irc from "./irc.js";
import logging from "./log.js";
import Room from "./room.js";
import util from "./util.js";
import UserStore from "./users.js";
import TMIWebSocket from "./WebSocket.js";

var logger = logging._getLogger("session");

// Reconnect timeout in session protects us when we don't get PARTs
// for all rooms (and thus no 'closed' event on the connection)
// Should be longer than the rooms' reconnect timeout.
var RECONNECT_TIMEOUT = util.time.seconds(20);

// TODO: Convert to ES6 class
var SessionManager = function (opts) {
  this.isDestroyed = false;
  this._opts = opts;
  this.nickname = opts.nickname;
  this.userId = opts.userId;

  this._depotApi = api.chatdepot.init(opts.oauthToken);
  this._tmiApi = api.tmi.init(opts.oauthToken);
  this._twitchApi = api.twitch.init({
    hostport: opts.apiHostport,
    oauthToken: opts.oauthToken
  });

  this._darklaunchEligible = TMIWebSocket.supported();

  this._darklaunchConn = new Connection({
    cluster: "darklaunch",
    addrs: [{host:"irc.darklaunch.us-west2.twitch.tv", port:80}],
    wsAddrs: [{protocol:"wss", host:"irc-ws-darklaunch.chat.twitch.tv", port:443}],
    nickname: this.nickname,
    password: this._opts.password,
    useWebSockets: true,

    // Make sure that users don't see any Darklaunch messages in their console,
    // this only makes debugging more confusing
    logger: logging._noopLogger
  });

  this._connections = {};
  this._ignored = {};
  this._rooms = {};
  this._invited = {};
  this._deletedRooms = {};
  this._createdRoomDeferreds = [];
  this._roomMembershipsDeferred = null;
  this.ignoredDeferred = null;

  // FIXME: Check to see if Twitch special messages are room-specific.
  // Twitch special messages (USERCOLOR, EMOTESET, SPECIALUSER, etc)
  // are sent to the session and have no reference to a room. We're
  // storing user data globally per connection, but if a SPECIALUSER
  // message is only relevant for a particular room the client is
  // connected to this won't work. If thats the case, we'll need to
  // patch the server to pass IRC channel for twitch messages.
  this._users = new UserStore();

  if (opts.oauthToken) {
    this.ignoredDeferred = this._fetchIgnored();
  }
};

SessionManager.prototype = new EventsDispatcher();

SessionManager.prototype.destroy = function () {
  $.each(this._rooms, function (name, room) {
    room.exit();
  });
  $.each(this._connections, function (cluster, conn) {
    conn.close();
  });

  this._depotApi.destroy();
  this._tmiApi.destroy();
  this._twitchApi.destroy();

  TMI._onSessionDestroyed(this);
  this.isDestroyed = true;
};

SessionManager.prototype.createRoom = function (options) {
  var deferred = $.Deferred(),
      self = this;
  options = options || {};

  if (!(options.ircChannel && options.displayName)) {
    logger.error("createRoom requires name and displayName");
    deferred.reject();
    return deferred;
  }

  self._depotApi.post('/rooms', {
    irc_channel: options.ircChannel,
    display_name: options.displayName
  }).done(function (response) {
    var room = self._updateGroupRoom(response.room);
    self._rememberCreated(room.name);
    self._onListRoomsChanged();
    deferred.resolve(room);
  }).fail(api.chatdepot.fail(deferred));

  return deferred;
};

SessionManager.prototype._rememberCreated = function (roomName) {
  // Briefly remember created room to protect against replication lag
  var deferred = $.Deferred(),
      self = this;

  self._depotApi.get('/room_memberships/' + roomName + '/' + self.userId).done(function (membershipResponse) {
    setTimeout(function () {
      self._createdRoomDeferreds = $.grep(self._createdRoomDeferreds, function (createdRoomDeferred) {
        return createdRoomDeferred !== deferred;
      });
    }, util.time.seconds(5));
    deferred.resolve(self._updateGroupRoomMembership(membershipResponse.membership));
  }).fail(function () {
    deferred.reject();
  });

  self._createdRoomDeferreds.push(deferred);
};

SessionManager.prototype._rememberDeleted = function (name) {
  // Briefly remember deleted room name to protect against replication lag
  var self = this;

  self._deletedRooms[name] = true;

  setTimeout(function () {
    delete self._deletedRooms[name];
  }, util.time.seconds(5));
};

SessionManager.prototype.getRoom = function (roomName, ownerId) {
  var deferred = $.Deferred(),
      self = this;

  if (Room.isGroupRoomName(roomName)) {
    var room = self._rooms[roomName];
    if (room && !room._isDirty) {
      deferred.resolve(room);
    } else {
      self._depotApi.get('/rooms/' + roomName).done(function (response) {
        deferred.resolve(self._updateGroupRoom(response.room));
      }).fail(api.chatdepot.fail(deferred));
    }
  } else {
    var roomInfo = self._getRoomInfo(roomName, ownerId);
    var conn = self._getOrNewConnection(roomInfo);
    deferred.resolve(self._updatePublicRoom({
      name: roomName,
      connection: conn,
      ownerId: ownerId
    }));
  }

  return deferred;
};

SessionManager.prototype.listRooms = function () {
  var self = this,
      deferred = $.Deferred();

  if (!self._opts.oauthToken) {
    deferred.resolve([]);
    return deferred;
  }

  if (!self._roomMembershipsDeferred) {
    setTimeout(function () {
      self._roomMembershipsDeferred = null;
    },
    util.time.seconds(30));
    self._roomMembershipsDeferred = self._getRoomMemberships();
  }

  self._roomMembershipsDeferred.done(function (rooms) {
    self._addCreatedRooms(rooms).done(function () {
      // Delete _after_ created rooms are pushed
      rooms = $.grep(rooms, function (room) {
        return self._deletedRooms[room.name] !== true;
      });

      deferred.resolve(rooms);
    }).fail(function () {
      // Silently drop created rooms from list if membership info request failed
    });
  }).fail(function () {
    self._roomMembershipsDeferred = null;
    deferred.reject.apply(deferred, arguments);
  });

  return deferred;
};

SessionManager.prototype._addCreatedRooms = function (rooms) {
  return $.when.apply($, this._createdRoomDeferreds).done(function () {
    var createdRooms = arguments;
    $.each(createdRooms, function (index, createdRoom) {
      var matches = $.grep(rooms, function (room) {
        return room.name === createdRoom.name;
      });
      if (matches.length === 0) {
        rooms.unshift(createdRoom);
      }
    });
  });
};

SessionManager.prototype._getRoomMemberships = function () {
  var deferred = $.Deferred(),
      self = this;

  self._depotApi.get('/room_memberships', {}, {cache:false}).done(function (response) {

    var ircChannels = [],
        ircChannel,
        rooms = [],
        room;

    $.each(response.memberships, function (index, data) {
      room = self._updateGroupRoomMembership(data);
      rooms.push(room);

      ircChannel = data.room.irc_channel;
      if (self._lastIrcChannels && self._lastIrcChannels.indexOf(ircChannel) < 0 && !room.acceptedInvite) {
        self._onRoomInvite(ircChannel);
      }
      ircChannels.push(ircChannel);
    });

    self._lastIrcChannels = ircChannels;

    deferred.resolve(rooms);
  }).fail(api.chatdepot.fail(deferred));

  return deferred;
};

SessionManager.prototype.runCommercial = function (channel, time) {
  var deferred = $.Deferred(),
      self = this;

  var options = {
    headers: {
      Accept: 'application/vnd.twitchtv.v3+json',
      'Content-Type': 'application/json; charset=utf-8'
    }
  };

  this._twitchApi.post('/kraken/channels/' + channel + '/commercial', {length: time}, options)
  .done(function (response) {
    var properties = {
      trigger: 'chat',
      length: time,
      channel: channel
    };
    Twitch.tracking.spadeAndMixpanel.trackEvent('commercial_request', properties);

    deferred.resolve();
  }).fail(function (response) {
    deferred.reject();
  });

  return deferred;

};

SessionManager.prototype.ignoreUser = function (username, reason, isWhisper) {
  var deferred = $.Deferred(),
      self = this;

  this._twitchApi.put('/kraken/users/' + this.nickname + '/blocks/' + username, {reason:reason, whisper:isWhisper})
  .done(function () {
    self._ignored[username.toLowerCase()] = true;
    deferred.resolve();
  }).fail(function (response) {
    deferred.reject();
  });

  return deferred;
};

SessionManager.prototype.isIgnored = function (username) {
  if (username) {
    username = username.toLowerCase();
  }
  return !!this._ignored[username];
};

SessionManager.prototype.unignoreUser = function (username) {
  var deferred = $.Deferred(),
      self = this;

  this._twitchApi.del('/kraken/users/' + this.nickname + '/blocks/' + username)
  .done(function () {
    delete self._ignored[username.toLowerCase()];
    deferred.resolve();
  }).fail(function (response) {
    deferred.reject();
  });

  return deferred;
};

SessionManager.prototype.setColor = function (color) {
  // TODO: This should probably be replaced by an API.
  // Currently ignores setting color if no connections are active. Also does
  // duplicate work by setting color on each connection.
  var self = this;
  $.each(self._connections, function (clusterKey, conn) {
    conn._send("PRIVMSG " + irc.channel(self.nickname) + " :/color " + color);
  });
  this._users.setColor(self.nickname, color);
};

SessionManager.prototype.getColor = function (username) {
  var color = this._users.getColor(username);
  if (!color) {
    color = util.array.pickRandom(UserStore.COLORS);
    this._users.setColor(username, color);
  }
  return color;
};

SessionManager.prototype.getDisplayName = function (username) {
  return this._users.getDisplayName(username);
};

SessionManager.prototype.fetchDisplayName = function (username) {
  var self = this,
      deferred = $.Deferred();

  var displayName = self._users.getDisplayName(username);

  if (displayName) {
    deferred.resolve(displayName);
  } else {
    self._twitchApi.get('/kraken/users/' + username)
      .done(function (response) {
        self._users.setDisplayName(username, response.display_name);
        deferred.resolve(response.display_name);
      })
      .fail(function () {
        deferred.reject();
      });
  }

  return deferred.promise();
};

SessionManager.prototype.isUsingWebSockets = function () {
  for (var cluster in this._connections) {
    if (this._connections[cluster].isUsingWebSockets()) {
      return true;
    }
  }
  return false;
};

SessionManager.prototype.getMessageRate = function () {
  var rate = 0;
  $.each(this._connections, function (cluster, conn) {
    rate += conn.getMessageRate();
  });
  return rate;
};

SessionManager.prototype._getOrNewConnection = function (opts) {
  if (!this._connections.hasOwnProperty(opts.cluster) || this._connections[opts.cluster]._flashTimedOut) {
    var addrs = opts.addrs,
        wsAddrs = opts.wsAddrs || [],
        forceHost = util.urlParams.tmi_host,
        forcePort = parseInt(util.urlParams.tmi_port),
        forceSecure = util.urlParams.tmi_secure === 'true';

    if (forceHost) {
      var HOST_WHITELIST = [/^localhost$/, /\.twitch\.tv$/, /\.justin\.tv$/];

      var rejected = true;
      for (var index in HOST_WHITELIST) {
        if (HOST_WHITELIST[index].test(forceHost)) {
          rejected = false;
          addrs = [{
            host: forceHost,
            port: forcePort
          }];
          wsAddrs = [{
            host: forceHost,
            port: forcePort,
            protocol: forceSecure ? 'wss' : 'ws'
          }];
          break;
        }
      }

      if (rejected) {
        var error = "Non-whitelisted tmi_host";
        logger.error(error);
        throw error;
      }
    }

    // We limit all darklaunch connections by whether they could support
    // websockets to keep the distribution of ws/flash at 1:1.
    var enableDarklaunch = this._darklaunchEligible && opts.darklaunchEnabled;

    var conn = new Connection({
      cluster: opts.cluster,
      addrs: addrs,
      wsAddrs: wsAddrs,
      nickname: this.nickname,
      password: this._opts.password,
      allowWebSockets: true,
      useWebSockets: true,
      webSocketPct: opts.webSocketPct,
      darklaunchConn: (enableDarklaunch ? this._darklaunchConn : null)
    });
    this._setConnection(conn);
  }
  return this._connections[opts.cluster];
};

SessionManager.prototype._bindConn = function (conn) {
  conn.on('disconnected', this._onConnDisconnected, this);
  conn.on('usercolor', this._onUserColorChanged, this);
  conn.on('specialuser', this._onUserSpecialAdded, this);
  conn.on('reconnecting', this._onReconnecting, this);
  conn.on('roomban', this._onListRoomsChanged, this);
  conn.on('roomchanged', this._onListRoomsChanged, this);
  conn.on('roomdeleted', this._onListRoomsChanged, this);
  conn.on('roominvite', this._onRoomInvite, this);
  conn.on('flashdisabled', this._onFlashDisabled, this);
  conn.on('userstate', this._onUserStateUpdated, this);
  conn.on('flashtimeout', this._onFlashTimeout, this);
};

SessionManager.prototype._unbindConn = function (conn) {
  conn.off('disconnected', this._onConnDisconnected, this);
  conn.off('usercolor', this._onUserColorChanged, this);
  conn.off('specialuser', this._onUserSpecialAdded, this);
  conn.off('reconnecting', this._onReconnecting, this);
  conn.off('roomban', this._onListRoomsChanged, this);
  conn.off('roomchanged', this._onListRoomsChanged, this);
  conn.off('roomdeleted', this._onListRoomsChanged, this);
  conn.off('roominvite', this._onRoomInvite, this);
  conn.off('flashdisabled', this._onFlashDisabled, this);
  conn.off('userstate', this._onUserStateUpdated, this);
  conn.off('flashtimeout', this._onFlashTimeout, this);
};


SessionManager.prototype._onUserStateUpdated = function (msg) {
  this._updateUserState(this.nickname, msg.tags);
};

SessionManager.prototype._updateUserState = function (user, tags) {
  if (tags.color) {
    this._onUserColorChanged(user, tags.color);
  }
  if (tags['display-name']) {
    this._onUserDisplayNameChanged(user, tags['display-name']);
  }
  if (tags.turbo) {
    this._onUserSpecialAdded(user, "turbo");
  }
  if (tags['golden-kappa']) {
    this._onUserSpecialAdded(user, "golden-kappa");
  }
  switch (tags["user-type"]) {
  // turbo/staff are global user states, other user-types are room-specific
  // and are handled by the room
  case "staff":
  case "admin":
  case "global_mod":
    this._onUserSpecialAdded(user, tags["user-type"]);
    this._trigger('labelschanged', user);
    break;
  }
};

SessionManager.prototype._setConnection = function (conn) {
  this._bindConn(conn);
  logger.info("Adding connection for cluster " + conn.cluster + " to session.");
  this._connections[conn.cluster] = conn;
};

SessionManager.prototype._updateGroupRoom = function (roomData) {
  var room = this._rooms[roomData.irc_channel];

  if (room) {
    room.displayName = roomData.display_name;
    room.publicInvitesEnabled = !!roomData.public_invites_enabled;
  } else {
    var roomInfo = this._getRoomInfo(roomData.irc_channel, roomData.owner_id);
    var conn = this._getOrNewConnection(roomInfo);

    room = this._rooms[roomData.irc_channel] = new Room({
      name: roomData.irc_channel,
      displayName: roomData.display_name,
      ownerId: roomData.owner_id,
      publicInvitesEnabled: !!roomData.public_invites_enabled,
      chattersListUrl: roomData.chatters_list_url,
      session: this,
      connection: conn,
      whisperConn: this._connections.group
    });
  }

  room._isDirty = false;

  return room;
};

SessionManager.prototype._updateGroupRoomMembership = function (membershipData) {
  var room = this._updateGroupRoom(membershipData.room);
  room.acceptedInvite = membershipData.is_confirmed;
  room.inviter = membershipData.inviter;
  room.isOwner = membershipData.is_owner;
  room.userId = membershipData.user.id;

  if (membershipData.is_mod) {
    room._roomUserLabels.add(this.nickname, 'mod');
  }
  return room;
};

SessionManager.prototype._updatePublicRoom = function (roomData) {
  var room = this._rooms[roomData.name];
  if (!room) {
    room = this._rooms[roomData.name] = new Room({
      session: this,
      name: roomData.name,
      ownerId: roomData.ownerId,
      chattersListUrl: this._buildChattersListUrl(roomData.name, roomData.connection._opts.cluster),
      connection: roomData.connection,
      whisperConn: this._connections.group
    });
  }
  return room;
};

SessionManager.prototype._buildChattersListUrl = function (roomName, cluster) {
  var forceBaseURL = "tmi.twitch.tv";
  var m = /^[a-z]+\.twitch\.tv(?::\d+)?$/.exec(util.urlParams.tmi_http_base_url);
  if (m) // prevents newline injection attacks (^ matches /any line/ in input)
      forceBaseURL = m[0];
  return '//' + forceBaseURL + '/group/user/' + roomName + '/chatters';
};

SessionManager.prototype._fetchIgnored = function () {
  var deferred = $.Deferred(),
      self = this;

  this._twitchApi.get('/kraken/users/' + this.nickname + '/blocks', {limit: 500})
    .done(function (result) {
      $.each(result.blocks, function (index, block) {
        self._ignored[block.user.name.toLowerCase()] = true;
      });
      deferred.resolve();
    }).fail(function () {
      deferred.reject();
    });

  return deferred;
};

SessionManager.prototype._getRoomInfo = function (roomName, ownerId) {
  var addrs = [
    {host:"irc.chat.twitch.tv", port:"80"},
    {host:"irc.chat.twitch.tv", port:"6667"}
  ];
  var wsAddrs = [{protocol:"wss", host:"irc-ws.chat.twitch.tv", port:"443"}];

  return {
    darklaunchEnabled: Math.random() < 0.1,
    cluster: "main",
    addrs: addrs,
    wsAddrs: wsAddrs,
    ownerId: ownerId
  };
};

SessionManager.prototype._onRoomInvite = function (ircChannel, by) {
  logger.info('Received invite to ' + ircChannel + ' from ' + by);
  if (this._invited[ircChannel]) {
    logger.warning('Duplicate invite to ' + ircChannel + ' from ' + by);
  } else if (by && this._ignored[by.toLowerCase()]) {
    logger.warning('Ignored invite to ' + ircChannel + ' from ' + by);
  } else {
    this._invited[ircChannel] = true;

    // Delay invite to protect against replication delay
    var self = this;
    setTimeout(function () {
      self._onListRoomsChanged();
      // trigger 'invited' AFTER onListRoomsChanged so that we can make sure
      // the rooms list will be updated during the 'invited' handler
      self._trigger('invited', {
        by: by,
        ircChannel: ircChannel
      });
    }, util.time.seconds(3));
  }
};

SessionManager.prototype._onListRoomsChanged = function () {
  this._roomMembershipsDeferred = null;
  this._trigger('listroomschanged');
};

SessionManager.prototype._onUserColorChanged = function (username, color) {
  this._users.setColor(username, color);
  this._trigger("colorchanged", username);
};

SessionManager.prototype._onUserSpecialAdded = function (username, special) {
  this._users.addSpecial(username, special);
};

SessionManager.prototype._onUserDisplayNameChanged = function (username, displayName) {
  this._users.setDisplayName(username, displayName);
};

SessionManager.prototype._onReconnecting = function (newConn) {
  var self = this;

  var oldConn = self._connections[newConn.cluster];

  var key = newConn.cluster + "_old";
  self._connections[key] = oldConn;
  self._setConnection(newConn);

  var closed = false;
  var onClosed = function () {
    if (closed) return;
    closed = true;
    self._unbindConn(self._connections[key]);
    delete self._connections[key];
    newConn._reconnecting = oldConn._reconnecting = false;
    oldConn.off('closed', onClosed);
  };

  oldConn.on('closed', onClosed);
  setTimeout(onClosed, RECONNECT_TIMEOUT);
};

SessionManager.prototype._onConnDisconnected = function (conn) {
  this._trigger('connection:disconnected', {
    cluster: conn.cluster
  });
};

SessionManager.prototype._onFlashDisabled = function () {
  this._trigger('flashdisabled');
};

SessionManager.prototype._onFlashTimeout = function () {
  this._trigger('flashtimedout');
};

SessionManager.prototype.updateChannel = function (channelId, data) {
  return this._tmiApi.put('/api/channels/' + channelId, data);
};

SessionManager.prototype.sendWhisper = function (username, message) {
  var conn = this._getOrNewConnection({cluster: 'main'});
  var whisperMsg = '/w ' + username + ' ' + message;
  conn._send("PRIVMSG #jtv :" + whisperMsg);

  this._triggerWhisper({
    sender: this.nickname,
    to: username,
    message: message
  });
};

SessionManager.prototype._triggerWhisper = function (msg) {
  this._trigger('whisper', {
    style: 'whisper',
    from: msg.sender,
    to: msg.to,
    message: msg.message,
    tags: msg.tags || {
      badges: msg.tags.badges,
      emotes: {}, // deprecated code path - the only use case (creative comissions) does not include any emotes
      'display-name': this.getDisplayName(msg.sender)
    },
    date: new Date()
  });
};

export default SessionManager;
