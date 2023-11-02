/* global $, TMI, Twitch, console */

import EventsDispatcher from "./events.js";
import FlashSocket from "./socket.js";
import TMIWebSocket from "./WebSocket.js";
import Room from "./room.js";
import logging from "./log.js";
import util from "./util.js";
import irc from "./irc.js";
import UserStore from "./users.js";

var logger = logging._getLogger("conn");

var APPEND_NULL_BYTE = true;
var SEND_SUFFIX = "\r\n";
var INVALID_CHARS = [/[\r\n]+/, String.fromCharCode(0)];
var MAX_CONNECTION_ATTEMPTS = 8;
var MAX_WEB_SOCKET_CONNECTION_ATTEMPTS = 3;

var PING_TIMEOUT = 10 * 1000; // 10 seconds
var PING_INTERVAL = 5 * 60 * 1000; // 5 minutes
var PING_JITTER = 10 * 1000; // 10 seconds
var DARKLAUNCH_DEFER_TIME = 30 * 1000; // 30 seconds

// TODO: Convert to ES6 class
var Connection = function (opts) {
  this._opts = opts;
  this.nickname = opts.nickname;
  this.cluster = opts.cluster;
  this._reconnecting = !!opts.reconnecting;

  this._logger = opts.logger ? opts.logger : logger;

  this._roomConns = [];

  // We randomly shuffle the addresses for the connection. That way if a server dies the load
  // from the dead server(s) is distributed evenly between the remaining servers.
  this._addrs = util.array.shuffle(opts.addrs);
  this._wsAddrs = util.array.shuffle(opts.wsAddrs);

  if (opts.preferredAddr) {
    // Shift PreferredAddr to the front of its address pool
    for (var i = 0; i < this._addrs.length; i++) {
      let addr = this._addrs[i];
      if (addr.host === opts.preferredAddr.host && addr.port === opts.preferredAddr.port) {
        this._addrs[i] = this._addrs[0];
        this._addrs[0] = addr;
        break;
      }
    }

    for (i = 0; i < this._wsAddrs.length; i++) {
      let addr = this._wsAddrs[i];
      if (addr.host === opts.preferredAddr.host && addr.port === opts.preferredAddr.port) {
        this._wsAddrs[i] = this._wsAddrs[0];
        this._wsAddrs[0] = addr;
        break;
      }
    }
  }

  // Indicates connecting or connected
  this.isActive = false;

  // Indicates a valid IRC session has started
  // TODO: Remove isConnected and "connect/connected" events (it was replaced by open/opened)
  this.isOpen = this.isConnected = false;

  this._wasCloseCalled = false;

  this._numSocketConnectAttempts = 0;
  this._retryConnectionTimeout = null;

  this._currentAddressIndex = -1;
  this._currentWSAddressIndex = -1;

  var useWebSockets = false;
  var websocketPct = opts.webSocketPct || 0;
  this._webSocketFailed = false;
  if ((util.urlParams.useWebSockets && opts.allowWebSockets) ||
      (opts.useWebSockets && opts.wsAddrs.length)) {
    useWebSockets = true;
  } else if (this._canSupportWebSockets() && opts.allowWebSockets) {
    var deviceId = Twitch.idsForMixpanel.getOrCreateUniqueId();
    var value = parseInt(deviceId.slice(0, 8), 16) / Math.pow(2, 32);
    useWebSockets = value < websocketPct;
  }
  this._initSocket(useWebSockets);
};

Connection.prototype = new EventsDispatcher();

Connection.prototype._initSocket = function (useWebSockets) {
  this._isUsingWebSockets = useWebSockets;
  if (useWebSockets) {
    this._socket = new TMIWebSocket({
      trackTimings: (Math.random() < 0.1),
      logger: this._logger
    });
  } else {
    this._socket = new FlashSocket({
      logger: this._logger
    });
  }
  this._flashTimedOut = false;

  this._socket.on('connected', this._onSocketConnected, this);
  this._socket.on('closed', this._onSocketClosed, this);
  this._socket.on('error', this._onSocketConnectFailed, this);
  this._socket.on('data', this._onSocketDataReceived, this);
  this._socket.on('flashtimeout', this._onFlashTimeout, this);
  this._socket.on('wssupporterror', this._onWebSocketSupportError, this);
  this._socket.load();
};

Connection.prototype.isUsingWebSockets = function () {
  return this._isUsingWebSockets;
};

// FIXME: How should we deal with timeouts?
Connection.prototype.open = function () {
  this._wasCloseCalled = false;
  if (!this.isActive) {
    this._logger.info("Connecting...");
    this.isActive = true;
    if (!this._triggerIfFlashDisabled()) {
      if (this._isReadyToConnect()) {
        this._connectToNextAddress();
      }
    }
  }
  if (this._opts.darklaunchConn) {
    // Defer connecting to darklaunch to reduce resource contention during page load.
    setTimeout(this._darklaunchOpen.bind(this), DARKLAUNCH_DEFER_TIME);
  }
};

Connection.prototype.connect = function () {
  this._logger.warning("Connection.connect() is deprecated. Use open() instead.");
  this.open();
};

Connection.prototype.close = function () {
  if (this.isActive) {
    this._logger.info("Closing connection...");
  }
  this.isActive = this.isOpen = this.isConnected = false;
  this._wasCloseCalled = true;
  this._stopConnecting();
  this._socket.close();
};

Connection.prototype.getMessageRate = function () {
  return this._socket.getMessageRate();
};

Connection.prototype._darklaunchOpen = function () {
  try {
    this._opts.darklaunchConn.open();
  } catch (err) {
    // Ignore darklaunch errors
  }
};

Connection.prototype._addRoomConn = function (roomConn) {
  this._roomConns.push(roomConn);
};

Connection.prototype._activeRoomConns = function () {
  return $.grep(this._roomConns, function (room) {
    return room.isActive;
  });
};

Connection.prototype._onSocketConnected = function (data) {
  this._logger.debug("Socket connected.");
  if (this.isActive) {
    var addr = this._getCurrentAddress();
    this._logger.info("Successfully opened connection to " + addr.host + ":" + addr.port +
                ". Attempting to register with IRC server.");
    this._send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    this._send("PASS " + this._opts.password);
    this._send("NICK " + this._opts.nickname);
    // add up to 10s jitter to prevent all clients from pinging at the same time
    this._pingInterval = setInterval(util.callback(this._doPing, this), PING_INTERVAL + util.randomInt(PING_JITTER));
    // "connected" is dispatched when we successfully register with the IRC server
  } else {
    this._logger.warning("Socket connected but connection is not active. Closing socket...");
    this._socket.close();
  }
};

Connection.prototype._onSocketConnectFailed = function (data) {
  this._logger.debug("Socket connect failed.");
  this.isOpen = this.isConnected = false;
  if (this.isActive) {
    this._connectionFailed("Unable to connect.");
  } else if (this._wasCloseCalled) {
    this._logger.info("Connection closed.");
    // If a socket connection failed but and the user closed the connection, just pretend it closed
    this._connectionClosed();
  }
};

Connection.prototype._onSocketClosed = function (data) {
  this._logger.debug("Socket closed.");
  var wasOpen = this.isOpen;
  this.isOpen = this.isConnected = false;
  if (this._pingInterval) {
    clearInterval(this._pingInterval);
  }
  if (this.isActive) {
    this._connectionFailed(wasOpen ? "Connection closed unexpectedly." : "Unable to connect.");
    if (wasOpen) {
      this._trigger('disconnected', this);
    }
  } else if (this._wasCloseCalled) {
    this._logger.info("Connection closed.");
    // If the connection is not active and close was NOT called, there is no reason
    // to dispatch "closed" because no one cares.
    this._connectionClosed();
  }
};

Connection.prototype._onSocketDataReceived = function (data) {
  this._logger.debug("Socket data received: " + data.data);
  var msg = irc.parseMessage(data.data);

  switch (msg.command) {
  case "PRIVMSG":
    if (irc.isChannel(msg.target)) {
      // FIXME: ROOMCHANGED is coming from twitchnotify for now, use this until resolved
      var TEMPORARY_PROTOCOL_KLUDGE = (msg.sender === 'twitchnotify' &&
                                        msg.message.slice(0, 11) === 'ROOMCHANGED');
      if (msg.sender === 'jtv' || TEMPORARY_PROTOCOL_KLUDGE) {
        this._handleTmiPrivmsg(msg);
      } else {
        this._trigger("message", msg);
      }
    } else {
      // FIXME: likely deprecated once we no longer use old protocol
      this._handleTmiPrivmsg(msg);
    }
    break;
  case "USERNOTICE":
    this._trigger("usernotice", msg);
    break;

  case "HOSTTARGET":
    this._trigger(
      "hosttarget",
      msg.target,
      msg.hostTarget,
      msg.numViewers,
      msg.recentlyJoined
    );
    break;

  case "CLEARCHAT":
    this._trigger("clearchat", msg.target, msg.user, msg.tags);
    break;

  case "USERSTATE":
  case "GLOBALUSERSTATE":
    this._trigger("userstate", msg);
    break;

  case "PING":
    // Sending PONG in response tells the server not to close the connection
    this._send("PONG");
    break;

  case "PONG":
    this._onPong();
    break;

    // FIXME: Handle authorization failures (invalid oauth token and such)
  case "004":
    // 001 - 004 messages indicate successful registration with the IRC server
    this._ircRegistered();
    break;

  case "RECONNECT":
    this._onReconnect();
    break;

  case "NOTICE":
    this._trigger("notice", msg);
    break;

  case "WHISPER":
    this._trigger("whisper", msg);
    break;

  case "ROOMSTATE":
    this._trigger("roomstate", msg);
    break;

  default:
    if (irc.isChannel(msg.target)) {
      this._trigger("message", msg);
    }
    break;
  }
};

Connection.prototype._handleTmiPrivmsg = function (msg) {
  var tmiMsg = irc.parseTmiPrivmsg(msg);
  switch (tmiMsg.type) {
  case "ROOMBAN":
    this._trigger("roomban", irc.channel(tmiMsg.user));
    break;
  case "ROOMCHANGED":
    this._trigger("roomchanged", tmiMsg.target);
    break;
  case "ROOMDELETED":
    this._trigger("roomdeleted", tmiMsg.target);
    break;
  case "ROOMINVITE":
    this._trigger("roominvite", tmiMsg.user, tmiMsg.payload.by);
    break;
  default:
    this._trigger("privmsg", {
      style: tmiMsg.style,
      target: tmiMsg.target,
      message: tmiMsg.payload
    });
    break;
  }
};

Connection.prototype._ircRegistered = function () {
  this._setExperimentState();
  this._logger.info("IRC connected.");
  // Reset the retry loop
  this._numSocketConnectAttempts = 1;
  this.isOpen = this.isConnected = true;
  this._trigger("opened");
  this._trigger("connected"); // FIXME: delete if unused
};

Connection.prototype._connectionClosed = function () {
  this._wasCloseCalled = false;
  this._trigger("closed");
};

Connection.prototype._connectionFailed = function (reasonMsg) {
  if (this._numSocketConnectAttempts < MAX_CONNECTION_ATTEMPTS) {
    if (this._isUsingWebSockets && this._numSocketConnectAttempts >= MAX_WEB_SOCKET_CONNECTION_ATTEMPTS && this.cluster !== "darklaunch") {
      this._webSocketFailOver();
      this._logger.warning(reasonMsg + " Giving up on websockets, attempting to initialize flash socket...");
    }

    var retryDelay = util.time.seconds(Math.pow(2, this._numSocketConnectAttempts));
    this._retryConnectionTimeout = setTimeout(util.callback(this._retryConnecting, this), retryDelay);
    this._logger.warning(reasonMsg + " Attempting to connect again in " + (retryDelay / 1000) + " seconds...");
    this._trigger("open:retry", {
      delay: retryDelay
    });
    this._trigger("connect:retry", { // FIXME: delete if unused
      delay: retryDelay
    });
  } else {
    this._logger.critical("Connection failed repeatedly after " + this._numSocketConnectAttempts + " connection attempts. " +
                    "There will be no more attempts to connect.");
    this._stopConnecting();
    this._trigger("open:failed");
    this._trigger("connect:failed"); // FIXME: delete if unused
  }
};

Connection.prototype._webSocketFailOver = function () {
  this._webSocketFailed = true;
  this._socket.close();
  this._initSocket(false);
  if (this.isActive) {
    this._triggerIfFlashDisabled();
  }
};

Connection.prototype._canSupportWebSockets = function () {
  return !this.webSocketFailed &&
         this._wsAddrs.length > 0 &&
         TMIWebSocket.supported();
};

Connection.prototype._setExperimentState = function () {
  if (this.cluster === "darklaunch" || this.cluster === "group") {
    // These connections are not what interests us.
    return;
  }

  if (this._canSupportWebSockets() && !util.urlParams.useWebSockets) {
    var tracking = {
      experiment_id: 'websocket_chat',
      experiment_platform: 'web'
    };
    if (this._isUsingWebSockets) {
      tracking.experiment_group = 'websocket';
    } else {
      tracking.experiment_group = 'flash';
    }

    Twitch.tracking.spadeAndMixpanel.trackEvent('experiment_branch', tracking);
  }
};

Connection.prototype._onFlashDisabled = function (data) {
  this._logger.critical("Flash failed to load: " + data.error);
  this._trigger("flashdisabled");
};

Connection.prototype._onFlashTimeout = function (data) {
  this._logger.critical("Flash timeout: " + data.error);
  this._flashTimedOut = true;
  this._trigger('flashtimeout');

};

Connection.prototype._onWebSocketSupportError = function (data) {
  // Error occured in a class that means we likely can't support websockets.
};

Connection.prototype._onReconnect = function () {
  this._logger.info("Reconnect request received");

  if (!this._reconnecting) {
    this._reconnecting = true;
    var newConn = new Connection($.extend(this._opts, {
      preferredAddr: this._getCurrentAddress(),
      reconnecting: true
    }));
    this._trigger('reconnecting', newConn);
  }
};

Connection.prototype._retryConnecting = function () {
  this._stopConnecting();
  this._connectToNextAddress();
};

Connection.prototype._stopConnecting = function () {
  clearTimeout(this._retryConnectionTimeout);
  this._retryConnectionTimeout = null;
};

Connection.prototype._isReadyToConnect = function () {
  return this._retryConnectionTimeout === null && this._numSocketConnectAttempts < MAX_CONNECTION_ATTEMPTS;
};

Connection.prototype._send = function (data) {
  var sanitized = data;
  for (var i = 0; i < INVALID_CHARS.length; ++i) {
    sanitized = sanitized.replace(INVALID_CHARS[i], "");
  }
  this._logger.debug("Sending: " + sanitized);
  this._socket.send(sanitized + SEND_SUFFIX, APPEND_NULL_BYTE);
  if (this._opts.darklaunchConn) {
    try {
      this._opts.darklaunchConn._send(data);
    } catch (err) {
      // Ignore Darklaunch errors
    }
  }
};

Connection.prototype._connectToNextAddress = function () {
  var addr = this._getNextAddress();
  this._numSocketConnectAttempts += 1;
  this._logger.info("Connecting to socket with address " + addr.host + ":" + addr.port);
  this._socket.connect(addr);
};

Connection.prototype._getNextAddress = function () {
  if (this._isUsingWebSockets) {
    this._currentWSAddressIndex = util.array.getNextIndex(this._wsAddrs, this._currentWSAddressIndex);
    return this._wsAddrs[this._currentWSAddressIndex];
  } else {
    this._currentAddressIndex = util.array.getNextIndex(this._addrs, this._currentAddressIndex);
    return this._addrs[this._currentAddressIndex];
  }
};

Connection.prototype._getCurrentAddress = function () {
  if (this._isUsingWebSockets) {
    return this._wsAddrs[Math.max(this._currentWSAddressIndex, 0)];
  } else {
    return this._addrs[Math.max(this._currentAddressIndex, 0)];
  }
};

Connection.prototype._triggerIfFlashDisabled = function () {
  if (this._socket._flashMissing) {
    this._onFlashDisabled({error: "VERSION_0"});
    return true;
  } else if (this._socket._flashOld) {
    this._onFlashDisabled({error: "OLD_VERSION"});
    return true;
  }
  return false;
};

// client-side hearbeat management
Connection.prototype._doPing = function () {
  this._logger.debug("sending PING");
  this._send("PING");
  this._pingTimeout = setTimeout(util.callback(this._doPingTimeout, this), PING_TIMEOUT);
};

Connection.prototype._doPingTimeout = function () {
  this._logger.info("PONG not received after sending PING, disconnecting...");
  this._socket.close();
};

Connection.prototype._onPong = function () {
  this._logger.debug("recieved PONG");
  if (this._pingTimeout) {
    clearTimeout(this._pingTimeout);
  }
};

export default Connection;
