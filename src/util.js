/* global $ */

var util = {};

var UNESCAPE_CHARS = {
  ":": ";",
  "s": " ",
  "r": "\r",
  "n": "\n",
  "\\": "\\"
};

var ESCAPE_CHARS = {
  ";": "\:",
  " ": "\s",
  "\r": "r",
  "\n": "n",
  "\\": "\\\\"
};

util.callback = function (func, context) {
  return function () {
    return func.apply(context, arguments);
  };
};

util.randomInt = function (maxInt) {
  return Math.round(maxInt * Math.random());
};

util.host = window.location.host;

util.urlParams = (function () {
  var urlParams = {};
  var params = window.location.search.substr(1);
  var keyValues = params.split("&");
  for (var i = 0; i < keyValues.length; ++i) {
    var keyValue = keyValues[i].split("=");
    urlParams[decodeURIComponent(keyValue[0])] = keyValue.length > 1 ? decodeURIComponent(keyValue[1]) : "";
  }
  return urlParams;
}());

util.readCookie = function (name) {
  var nameEq = name + "=";
  var ca = window.document.cookie.split(';');
  for (var i = 0; i < ca.length; i++) {
    var c = util.string.trim(ca[i]);
    if (c.indexOf(nameEq) === 0) {
      return c.substring(nameEq.length, c.length);
    }
  }
  return null;
};

// Unescapes IRCv3 tags that have been escaped according to:
// https://github.com/ircv3/ircv3-specifications/blob/master/core/message-tags-3.2.md
util.unescapeTagValue = function (tag) {
  var result = "";
  for (var i = 0; i < tag.length; i++) {
    var c = tag.charAt(i);
    if (c == "\\") {
      if (i == tag.length - 1) {
        throw "Improperly escaped tag";
      }
      c = UNESCAPE_CHARS[tag.charAt(i + 1)];
      if (c === undefined) {
        throw "Improperly escaped tag";
      }
      i++;
    }
    result += c;
  }
  return result;
};

// escapes IRCv3 tags according to:
// https://github.com/ircv3/ircv3-specifications/blob/master/core/message-tags-3.2.md
util.escapeTagValue = function (tag) {
  var tagStr = tag.toString();
  var result = "";
  for (var i = 0; i < tagStr.length; i++) {
    var c = tagStr.charAt(i);
    // if the value is not found in our object, append original and move on.
    if (!ESCAPE_CHARS[c]) {
      result += c;
      continue;
    }
    result += ESCAPE_CHARS[c];
  }
  return result;
};

// converts badges from new array format to old object format
// used temporarily to preserve compatibility with extensions
util.convertBadgesTagToOldFormat = function (badges) {
  if (!badges) {
    return {};
  }

  var oldBadges = {};

  for (var i = 0; i < badges.length; i++) {
    var badge = badges[i];
    oldBadges[badge.id] = badge.version;
  }

  return oldBadges;
};

util.parseAddressesFromServers = function (servers) {
  var addrs = [],
      parts;
  for (var i = 0; i < servers.length; i++) {
    parts = servers[i].split(':');
    addrs.push({
      host: parts[0],
      port: parts[1]
    });
  }
  return addrs;
};

util.string = {
  trim: function (s) {
    return s.replace(/^\s+/, '').replace(/\s+$/, '');
  }
};

util.time = {
  seconds: function (num) {
    return num * 1000;
  },

  now: function () {
    return new Date().getTime();
  }
};

util.array = {
  remove: function (array, element) {
    var i = array.indexOf(element);
    if (i >= 0) {
      array.splice(1, 1);
    }
  },

  join: function () {
    var output = [];
    for (var i = 0; i < arguments.length; ++i) {
      Array.prototype.push.apply(output, arguments[i]);
    }
    return output;
  },

  pickRandom: function (array) {
    var randomIndex = Math.floor(Math.random() * array.length);
    return array[randomIndex];
  },

  // Knuth shuffle
  shuffle: function (array) {
    var output = array.slice(0),
        currentIndex = output.length,
        randomIndex,
        temporaryValue;

    while (0 !== currentIndex) {
      randomIndex = Math.floor(Math.random() * currentIndex);
      currentIndex -= 1;

      temporaryValue = output[currentIndex];
      output[currentIndex] = output[randomIndex];
      output[randomIndex] = temporaryValue;
    }

    return output;
  },

  // Loops through the indices of array, ie:
  // x = ["a", "b"]
  // getNextIndex(x, 0) == 1
  // getNextIndex(x, 1) == 0
  getNextIndex: function (array, currentIndex) {
    return (currentIndex + 1) % array.length;
  }
};

util.types = {};

// TODO: Convert to ES6 class
var SetStore = util.types.SetStore = function () {
  this._sets = {};
};

SetStore.prototype.add = function (key, value) {
  this._create(key)[value] = true;
};

SetStore.prototype.remove = function (key, value) {
  var set = this._get(key);
  if (set) {
    delete set[value];
  }
};

SetStore.prototype.get = function (key) {
  var output = [];
  var set = this._get(key);
  if (set) {
    for (var value in set) {
      if (set.hasOwnProperty(value)) {
        output.push(value);
      }
    }
  }
  return output;
};

SetStore.prototype._create = function (key) {
  if (!this._sets[key]) {
    this._sets[key] = {};
  }
  return this._sets[key];
};

SetStore.prototype._get = function (key) {
  return this._sets[key];
};

// TODO: Convert to ES6 class
var Tracker = util.types.Tracker = function () {
  this._data = {};
  this._timestamps = {};
  this._timings = {};
};

Tracker.prototype.startBenchmark = function (benchmark) {
  if (!this._timestamps.hasOwnProperty(benchmark)) {
    this._timestamps[benchmark] = util.time.now();
  }
};

Tracker.prototype.endBenchmark = function (benchmark) {
  if (this._timestamps.hasOwnProperty(benchmark) && !this._timings.hasOwnProperty(benchmark)) {
    this._timings[benchmark] = util.time.now() - this._timestamps[benchmark];
  }
};

Tracker.prototype.set = function (key, value) {
  if (!this._data.hasOwnProperty(key)) {
    this._data[key] = value;
  }
};

Tracker.prototype.increment = function (key, incrBy) {
  this._data[key] = (this._data[key] || 0) + incrBy;
};

Tracker.prototype.data = function () {
  var data = {};
  $.extend(data, this._data);
  $.extend(data, this._timings);
  return data;
};

export default util;
