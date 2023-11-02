/* global swfobject, $, TMI */

import logging from "./log.js";
import util from "./util.js";
import EventsDispatcher from "./events.js";

var logger = logging._getLogger("socket");

var MAX_LOAD_ATTEMPTS = 2;

var _flashSockets = {};
var _flashSocketId = 1;

// This must be globally accessible so that Flash can call TMI._flashSocket.callback
window._flashSocket = {
  eventsCallback: function (clientId, events) {
    setTimeout(function () {
      var flashSocket = _flashSockets[clientId],
          event;
      if (flashSocket) {
        for (var i = 0; i < events.length; i++) {
          event = events[i];
          try {
            flashSocket._onEvent(event);
          } catch (err) {
            logger.error("Error handling Flash socket event " + event.event + ": " + err.stack);
          }
        }
      }
    }, 1);
  }
};

// TODO: Convert to ES6 class
var FlashSocket = function (opts) {
  this._opts = opts;
  this._resetSwfState();
  this._shouldConnectAddr = null;
  this._hasAttemptedConnecting = false;
  this._isConnected = false;
  this._numLoadAttempts = 0;
  this._msgRate = 0;
  this._isLoading = false;
  this._flashMissing = false;
  this._flashOld = false;
  this._logger = opts.logger ? opts.logger : logger;
};

FlashSocket.prototype = new EventsDispatcher();

FlashSocket.prototype.load = function () {
  if (!this._isLoading) {
    this._isLoading = true;
    this._logger.info("Loading Flash socket SWF...");
    this._embedSocketSwf();
  }
};

FlashSocket.prototype.connect = function (addr) {
  if (!this._shouldConnectAddr) {
    this._shouldConnectAddr = {
      host: addr.host,
      port: addr.port
    };
    if (this._isSwfLoaded) {
      this._connectSwfSocket();
    }
  }
};

FlashSocket.prototype.close = function () {
  var shouldCloseSocketSwf = this._isSwfLoaded && this._hasAttemptedConnecting;
  this._reset();

  if (shouldCloseSocketSwf) {
    this._logger.debug("Calling close on SWF.");
    this._socketSwf.close();
  }
};

FlashSocket.prototype.send = function (data, appendNullByte) {
  if (this._isSwfLoaded && this._isConnected) {
    this._logger.debug("Calling send on SWF.");
    this._socketSwf.send(data, appendNullByte);
  } else {
    this._logger.warning("Attempted to send " + data + " over a disconnected Flash socket. Ignoring.");
  }
};

FlashSocket.prototype.getMessageRate = function () {
  return this._msgRate;
};

FlashSocket.prototype._onEvent = function (event) {
  switch (event.event) {
  case "loaded":
    this._logger.debug("Flash socket loaded.");
    this._onLoaded();
    break;
  case "connected":
    this._logger.debug("Flash socket connected.");
    this._onConnected(event);
    break;
  case "closed":
    this._logger.debug("Flash socket closed.");
    this._onClosed(event);
    break;
  case "data":
    this._logger.debug("Flash socket received data.");
    this._onDataReceived(event);
    break;
  case "data_buffer":
    if (event.buffer.length > 0) {
      this._logger.debug("Flash socket received buffered data.");
      for (var i = 0; i < event.buffer.length; i++) {
        try {
          this._onDataReceived({
            data: event.buffer[i]
          });
        } catch (err) {
          this._logger.error("Error handling Flash socket data: " + err.stack);
        }
      }
    }
    break;
  case "stats":
    this._logger.debug("Flash socket received stats.");
    this._msgRate = event.stats && event.stats.dataRate ? event.stats.dataRate : 0;
    break;
  case "error":
    this._logger.debug("Flash socket error");
    this._onError(event);
    break;
  case "exception":
    this._logger.error("Flash socket threw an exception while calling " + event.method + " on SWF: " + event.message);
    break;
  default:
    this._logger.warning("Invalid socket event: " + event.event);
    break;
  }
};

FlashSocket.prototype._connectSwfSocket = function () {
  this._hasAttemptedConnecting = true;
  this._logger.debug("Calling connect on SWF.");
  this._socketSwf.connect(this._shouldConnectAddr.host, this._shouldConnectAddr.port);
};

FlashSocket.prototype._onLoaded = function () {
  clearTimeout(this._swfLoadedTimeout);
  this._swfLoadedTimeout = null;
  this._socketSwf = document.getElementById(this._domId);
  this._isSwfLoaded = true;
  if (this._shouldConnectAddr) {
    this._connectSwfSocket();
  }
};

FlashSocket.prototype._onConnected = function (data) {
  this._isConnected = true;
  this._trigger("connected", data);
};

FlashSocket.prototype._onClosed = function (data) {
  // TODO: What are the cases where Flash dispatches closed?
  // After errors, or only after socket.close() calls?
  this._reset();
  this._trigger("closed", data);
};

FlashSocket.prototype._onError = function (data) {
  // TODO: Can an error occur while the connection is alive?
  // Or are there only errors while attempting to connect?
  // Are all errors fatal? Explore the cases where Flash dispatches errors.
  this._reset();
  this._trigger("error", data);
};

FlashSocket.prototype._onDataReceived = function (data) {
  // Data was encoded in Flash to prevent JS from interpretting escape sequences.
  data.data = decodeURIComponent(data.data);
  this._trigger("data", data);
};

FlashSocket.prototype._resetSwfState = function () {
  delete _flashSockets[this._clientId];
  this._clientId = _flashSocketId;
  _flashSockets[this._clientId] = this;
  _flashSocketId += 1;
  this._domId = "tmi_flash_socket_" + this._clientId;
  this._socketSwf = null;
  this._isSwfLoaded = false;
  this._swfLoadedTimeout = null;
  this._msgRate = 0;
};

FlashSocket.prototype._reset = function () {
  this._shouldConnectAddr = null;
  this._hasAttemptedConnecting = false;
  this._isConnected = false;
  this._msgRate = 0;
};

FlashSocket.prototype._onSwfLoadedTimeout = function () {
  this._clearSwfLoadedTimeout();
  this._logger.error("Could not load the Flash socket SWF. Timed out before receiving the 'loaded' event.");
  if (this._numLoadAttempts < MAX_LOAD_ATTEMPTS) {
    this._logger.info("Attempting to reload Flash socket SWF...");
    this._resetSwfState();
    this._embedSocketSwf();
  } else {
    this._logger.critical("Made " + MAX_LOAD_ATTEMPTS + " attempts to load the Flash socket SWF but they each " +
                    "timed out. There will be no more attempts.");
    this._trigger("flashtimeout", {error: "TIMEOUT"});
  }
};

FlashSocket.prototype._onFlashPlayerMissing = function () {
  this._logger.critical("Flash Player Missing. (Version 0 or DOM load failure)");
  this._flashMissing = true;
};

FlashSocket.prototype._onOldFlashVersion = function (reqVersion) {
  this._logger.critical("FlashVersion too old. Current: " + swfobject.getFlashPlayerVersion + ", required: " + reqVersion);
  this._flashOld = true;
};

FlashSocket.prototype._embedSocketSwf = function () {
  this._numLoadAttempts += 1;
  var self = this;
  this._swfLoadedTimeout = setTimeout(util.callback(this._onSwfLoadedTimeout, this), util.time.seconds(10));
  $(document).ready(function () {
    var socketSwfUrl = "/tmilibs/JSSocket.swf";
    var WHITELIST = [];
    if (util.urlParams.tmi_socket_swf_url) {
      if (WHITELIST.indexOf(util.urlParams.tmi_socket_swf_url) < 0) {
        var error = "Non-whitelisted tmi_socket_swf_url";
        this._logger.error(error);
        throw error;
      }
      socketSwfUrl = util.urlParams.tmi_socket_swf_url;
    }

    $('<div/>').attr('id', self._domId).appendTo('body');
    var embedOpts = {
      swf: socketSwfUrl,
      domId: self._domId,
      width: "0px",
      height: "0px",
      flashVersion: "10",
      installSwf: "/widgets/expressinstall.swf",
      flashVars: {
        eventsCallback: "_flashSocket.eventsCallback",
        clientId: self._clientId
      },
      flashParams: {
        allowScriptAccess: "always",
        allowNetworking: "all"
      },
      htmlAttrs: {
        name: self._domId,
        style: "position: absolute;"
      }
    };

    swfobject.embedSWF(
      embedOpts.swf,
      embedOpts.domId,
      embedOpts.width,
      embedOpts.height,
      embedOpts.flashVersion,
      embedOpts.installSwf,
      embedOpts.flashVars,
      embedOpts.flashParams,
      embedOpts.htmlAttrs,
      function (e) {
        if (!e.success) {
          self._clearSwfLoadedTimeout();
          if (swfobject.getFlashPlayerVersion().major === 0) {
            self._onFlashPlayerMissing();
          } else if (!swfobject.hasFlashPlayerVersion(embedOpts.flashVersion)) {
            self._onOldFlashVersion(embedOpts.flashVersion);
          } else {
            // DOM failed to load
            self._onFlashPlayerMissing();
          }
        }
      }
    );
  });
};

FlashSocket.prototype._clearSwfLoadedTimeout = function () {
  clearTimeout(this._swfLoadedTimeout);
  this._swfLoadedTimeout = null;
};

export default FlashSocket;
