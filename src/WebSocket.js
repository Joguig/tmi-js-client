/* global $ */

import logging from "./log.js";
import util from "./util.js";
import stats from "./stats.js";
import EventsDispatcher from "./events.js";
import RateCounter from "./RateCounter.js";

var logger = logging._getLogger("websocket");
const BUFFER_FLUSH_DELAY_MS = 100;
var _validProtocols = {"ws": true, "wss": true};

class TMIWebSocket extends EventsDispatcher {
  constructor (opts) {
    super(opts);
    this._opts = opts;
    this._socket = null;
    this._logger = opts.logger || logger;
    this._rateCounter = new RateCounter();
  }

  load () {
    this._logger.info("Socket Loaded");
  }

  connect (addr) {
    var host = addr.host;
    var port = addr.port;

    if (this._connected()) {
      this._logger.error("Attempting to reopen opened socket");
      return;
    } else if (this._socket) {
      this.close();
    }
    this._logger.info(`Opening Websocket to ${host}:${port}`);
    try {
      var prefix = _validProtocols.hasOwnProperty(addr.protocol) ? addr.protocol : "ws";
      this._logger.info(`websocket prefix: ${prefix}`);
      if (this._opts.trackTimings) {
        this._openTime = util.time.now();
      }
      this._socket = new WebSocket(`${prefix}://${host}:${port}`, 'irc');
    } catch (e) {
      this.close();
      this._onError(e);
      return;
    }
    this._socket.onmessage = this._onMessage.bind(this);
    this._socket.onerror = this._onError.bind(this);
    this._socket.onclose = this._onClose.bind(this);
    this._socket.onopen = this._onOpen.bind(this);
  }

  close () {
    if (!this._socket) {
      this._logger.error("Attempting to close socket before connecting");
      return;
    }

    if (this._socket.bufferedAmount) {
      this._logger.warning("Close called on socket with pending data");
    }

    this._socket.close();
  }

  send (data, appendNullByte) {
    if (!this._connected()) {
      // TODO: If this is behvaior we expect should we instead queue
      this._logger.error("Attempted to write to unopened socket");
      return;
    }
    this._socket.send(data);
  }

  // Assuming this to mean messages per second for last minute
  getMessageRate () {
    return this._rateCounter.getRatePerSecondForLastSeconds(60);
  }

  _connected () {
    return this._socket && (this._socket.readyState === WebSocket.OPEN);
  }

  _onOpen (event) {
    this._logger.info("Websocket open", event);
    if (this._opts.trackTimings) {
      var t = util.time.now() - this._openTime;
      stats.sendStatTimer("pubsub.tmi.websocket.connect", t);
    }
    this._trigger("connected");
  }

  _onMessage (event) {
    this._logger.info(event);
    var messages = event.data.split("\n");
    for (var i = 0; i < messages.length; i++) {
      if ($.trim(messages[i]).length === 0) {
        continue;
      }
      var data = {
        data: messages[i]
      };
      this._rateCounter.add();
      this._addMessage(data);
    }
  }

  _addMessage(data) {
    try {
      this._trigger("data", data);
    } catch (e) {
      this._logger.error("Error emitting socket data: " + e);
    }
  }

  _onError (event) {
    this._logger.info("Websocket error", event);
    this._trigger("error");
  }

  _onClose (event) {
    this._logger.info("Websocket closed", event);
    this._trigger("closed");
  }

  static supported () {
    return !!window.WebSocket;
  }
}

export default TMIWebSocket;
