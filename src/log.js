import util from "./util.js";

var noopLogFunc = function () {};
var _logFunc = noopLogFunc;
var _loggers = {};

var _logLevels = {
  "DEBUG": 1,
  "INFO": 2,
  "WARNING": 3,
  "ERROR": 4,
  "CRITICAL": 5
};
var _currentLogLevel = _logLevels.WARNING;

class Logger {
  constructor (opts) {
    this._opts = opts;
  }

  debug (msg) {
    if (_currentLogLevel <= _logLevels.DEBUG) {
      this._log(`DEBUG: ${msg}`);
    }
  }

  info (msg) {
    if (_currentLogLevel <= _logLevels.INFO) {
      this._log(`INFO: ${msg}`);
    }
  }

  warning (msg) {
    if (_currentLogLevel <= _logLevels.WARNING) {
      this._log(`WARNING: ${msg}`);
    }
  }

  error (msg) {
    if (_currentLogLevel <= _logLevels.ERROR) {
      this._log(`ERROR: ${msg}`);
    }
  }

  critical (msg) {
    if (_currentLogLevel <= _logLevels.CRITICAL) {
      this._log(`CRITICAL: ${msg}`);
    }
  }

  _log (msg) {
    var logMsg = this._opts.prefix + msg;
    if (this._opts.logFunc) {
      this._opts.logFunc(logMsg);
    } else {
      _logFunc(logMsg);
    }
  }
}

var logging = {

  setLogger: function (logFunc) {
    _logFunc = (typeof(logFunc) === "function") ? logFunc : noopLogFunc;
  },

  setLevel: (function () {
    var forcedLogLevel = (util.urlParams.tmi_log_level || "").toUpperCase();
    if (forcedLogLevel) {
      var forced = _logLevels[forcedLogLevel];
      if (forced) {
        _currentLogLevel = forced;
        // Return a noop -- attempting to change the log level should do nothing
        return function () {};
      }
    }

    return function (logLevel) {
      if (!logLevel) {
        _currentLogLevel = _logLevels.WARNING;
      } else {
        _currentLogLevel = _logLevels[logLevel.toUpperCase()] || _logLevels.WARNING;
      }
    };
  })(),

  _getLogger: function (name) {
    if (!_loggers[name]) {
      _loggers[name] = new Logger({
        prefix: `TMI.js [${name}] `
      });
    }
    return _loggers[name];
  },

  _noopLogger: new Logger({
    prefix: "",
    logFunc: noopLogFunc
  })

};

var console = window.console;
if (console && console.log) {
  // Prefer console.log if it exists
  if (console.log.apply) {
    logging.setLogger(function () { console.log.apply(console, arguments); });
  } else {
    // IE
    logging.setLogger(function () {
      var args = [];
      for (var i = 0; i < arguments.length; ++i) {
        args.push(arguments[i]);
      }
      console.log(args.join(" "));
    });
  }
}

export default logging;

