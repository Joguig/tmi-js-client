/* global $, TMI, console */

import util from "./util.js";
import logging from "./log.js";
import punycode from "punycode";

var logger = logging._getLogger("irc");

var TMI_MESSAGE_TYPES = {
  "ROOMBAN": true,
  "ROOMCHANGED": true,
  "ROOMDELETED": true,
  "ROOMINVITE": true
};

var parseBadgesTag = function (value="") {
  var parsedBadges = [];
  if (value === "") {
    return parsedBadges;
  }

  let badgeTags = value.split(',');
  for (let i = 0; i < badgeTags.length; i++) {
    let badgeTag = badgeTags[i];

    let [ badgeName, badgeVersion ] = badgeTag.split('/');
    let parsedBadge = {
      id: badgeName,
      version: badgeVersion
    };
    parsedBadges.push(parsedBadge);
  }

  return parsedBadges;
};

var parseEmotesTag = function (value) {
  var parsedEmotes = {};

  if (value === "") {
    return parsedEmotes;
  }

  var emotes = value.split("/");
  for (var i = 0; i < emotes.length; ++i) {
    try {
      var emoteParts = emotes[i].split(":");
      if (emoteParts.length != 2) {
        throw "invalid emotes";
      }
      var emoteIndices = [];
      var emoteIndiceParts = emoteParts[1].split(",");
      for (var j = 0; j < emoteIndiceParts.length; ++j) {
        var startEnd = emoteIndiceParts[j].split("-");
        if (startEnd.length != 2) {
          throw "invalid emotes";
        }
        var start = parseInt(startEnd[0]),
            end = parseInt(startEnd[1]);
        if (isNaN(start) || isNaN(end)) {
          throw "invalid emotes";
        }
        emoteIndices.push([start, end]);
      }

      if (emoteIndices.length > 0) {
        var emoteId = emoteParts[0];
        parsedEmotes[emoteId] = emoteIndices;
      }
    } catch (err) {
      logger.warning("Invalid emotes tag: ", emotes[i], ". Ignoring.");
    }
  }
  return parsedEmotes;
};

var convertEmoteIndicesToUCS2 = function (message, emotes) {
  emotes = emotes || {};

  var ucs2Offset = 0;
  var offsetByUTF8Index = [];
  var decoded = punycode.ucs2.decode(message);
  for (var i = 0; i < decoded.length; i++) {
    offsetByUTF8Index.push(ucs2Offset);
    if (decoded[i] > 0xFFFF) {
      // UCS2 characters are 2 byte fixed length code points,
      // so anything above this value is converted into 2 UCS2 characters
      ucs2Offset += 1;
    }
  }

  var ucs2Emotes = {};
  for (var emote in emotes) {
    if (!emotes.hasOwnProperty(emote)) {
      continue;
    }
    ucs2Emotes[emote] = [];
    var indices = emotes[emote];
    for (i = 0; i < indices.length; i++) {
      var start = indices[i][0];
      var end = indices[i][1];
      ucs2Emotes[emote].push([start + offsetByUTF8Index[start], end + offsetByUTF8Index[end]]);
    }
  }

  return ucs2Emotes;
};

var parseTwitchTag = function (tag, value) {
  switch (tag) {
  case "badges":
    return parseBadgesTag(value);
  case "emotes":
    return parseEmotesTag(value);
  case "sent-ts":
  case "tmi-sent-ts":
    return value;
  case "subscriber":
  case "mod":
  case "turbo":
  case "r9k":
  case "subs-only":
  case "historical":
  case "noisy":
  case "emote-only":
  case "mercury":
    return value === "1" ? true : false;
  case "slow":
  case "followers-only":
    return +value;
  default:
    try {
      var unescaped = util.unescapeTagValue(value);
      return unescaped;
    } catch (err) {
      logger.warning("Improperly escaped tag: ", tag, "=", value, ". Setting to empty string.");
      return "";
    }
  }
};

var parseTwitchTags = function (tagsString) {
  var tags = {};
  var keyValues = tagsString.split(";");
  for (var i = 0; i < keyValues.length; ++i) {
    var kv = keyValues[i].split("=");
    if (kv.length === 2) {
      tags[kv[0]] = parseTwitchTag(kv[0], kv[1]);
    } else {
      logger.warning("Unexpected tag: " + keyValues[i] + ". Ignoring.");
    }
  }

  // temporarily send the badges tag in both formats for compatibility
  if (tags.badges) {
    tags._badges = tags.badges;
    tags.badges = util.convertBadgesTagToOldFormat(tags._badges);
  }

  return tags;
};

var parseMessageParts = function (msgString) {
  // Only commands are required for IRC messages:
  // :<prefix> <command> <params> :<trailing>
  // See http://calebdelnay.com/blog/2010/11/parsing-the-irc-message-format-as-a-client
  // for a nice writeup on this parsing logic.
  msgString = $.trim(msgString);

  var parsedMsg = {
    tags: {},
    prefix: null,
    command: null,
    params: null,
    trailing: null
  };

  var tagsEnd = -1;
  if (msgString.charAt(0) === "@") {
    tagsEnd = msgString.indexOf(" ");
    parsedMsg.tags = parseTwitchTags(msgString.substr(1, tagsEnd - 1));
  }

  var prefixStart = tagsEnd + 1,
      prefixEnd = -1;
  if (msgString.charAt(prefixStart) === ":") {
    prefixEnd = msgString.indexOf(" ", prefixStart);
    parsedMsg.prefix = msgString.substr(prefixStart + 1, prefixEnd - (prefixStart + 1));
  }

  var trailingStart = msgString.indexOf(" :", prefixStart);
  if (trailingStart >= 0) {
    parsedMsg.trailing = msgString.substr(trailingStart + 2);
  } else {
    trailingStart = msgString.length;
  }

  var actionMatch = (parsedMsg.trailing || "").match(/^\u0001ACTION ([^\u0001]+)\u0001$/);
  if (actionMatch) {
    parsedMsg.style = 'action';
    parsedMsg.action = actionMatch[1];
  }

  var commandAndParams = msgString.substr(prefixEnd + 1, trailingStart - prefixEnd - 1).split(" ");
  parsedMsg.command = commandAndParams[0];
  if (commandAndParams.length > 1) {
    // UCS2 decoding for security... JS treats some UCS2 characters as 2 characters instead of 1 which is unexpected
    parsedMsg.params = commandAndParams.slice(1);
  }

  return parsedMsg;
};

var parseSender = function (msgParts) {
  if (!msgParts.prefix) {
    return null;
  }

  var senderEnd = msgParts.prefix.indexOf("!");
  if (senderEnd >= 0) {
    return msgParts.prefix.substr(0, senderEnd);
  }

  var sender = msgParts.prefix;

  if (sender === "tmi.twitch.tv" && msgParts.tags && msgParts.tags.login) {
    sender = msgParts.tags.login;
  }

  return sender;
};

var isValidUCS2 = function (message) {
  return message.length == punycode.ucs2.decode(message).length;
};

export default {

  channel: function (name) {
    return "#" + name;
  },

  isChannel: function (target) {
    return target && target.charAt(0) === "#";
  },


  // constructTags takes in an Object type and returns ircv3 formatted values
  constructTags: function (tags) {
    var tagString = "";
    for (var k in tags) {
      if (!tags.hasOwnProperty(k)) {
        continue;
      }
      tagString += ";" + k + "=" + util.escapeTagValue(tags[k]);
    }
    return tagString.substring(1);
  },


  // See http://tools.ietf.org/html/rfc2812#section-5 for documentation on IRC server replies
  parseMessage: function (msgString) {
    try {
      var msgParts = parseMessageParts(msgString),
          sender = parseSender(msgParts);

      var parsedMsg = $.extend({
        sender: sender
      }, msgParts);

      if (sender === 'jtv') {
        parsedMsg.style = 'admin';
      } else if (sender === 'twitchnotify') {
        parsedMsg.style = 'notification';
      }

      var merge = function (obj) {
        return $.extend(obj, parsedMsg);
      };

      switch (msgParts.command) {
      case "JOIN":
        // Sent after successfully joining a channel
        parsedMsg = merge({
          target: msgParts.params[0]
        });
        break;

      case "HOSTTARGET":
        var hostParams = msgParts.trailing.split(" ", 2);
        var numViewers = parseInt(hostParams[1], 10) || null;
        var user = hostParams[0];
        parsedMsg = merge({
          target: msgParts.params[0],
          hostTarget: user === "-" ? null : user,
          numViewers: numViewers,
          recentlyJoined: numViewers === null
        });
        break;

      case "CLEARCHAT":
        parsedMsg = merge({
          target: msgParts.params[0],
          user: msgParts.trailing
        });
        break;

      case "PART":
        parsedMsg = merge({
          target: msgParts.params[0]
        });
        break;

      case "USERNOTICE":
      case "PRIVMSG":
        // Channel messages from other users as well as system messages to the current user.
        // `target` will either be a channel name or the current users' name
        parsedMsg = merge({
          target: msgParts.params[0],
          message: msgParts.action || msgParts.trailing || ""
        });

        if (parsedMsg.tags.emotes) {
          parsedMsg.tags.emotes = convertEmoteIndicesToUCS2(parsedMsg.message, parsedMsg.tags.emotes);
        }
        break;

      case "GLOBALUSERSTATE":
        break;

      case "USERSTATE":
        parsedMsg = merge({
          target: msgParts.params[0]
        });
        break;

      // The following messages just return the default parsedMsg
      case "PING":
      case "PONG":
        // Respond to PING with PONG and the server won't close the connection

      case "001":
      case "002":
      case "003":
      case "004":
        // 001 - 004 replies upon successful registration to the IRC server

      case "375":
      case "372":
      case "376":
        // 375, 372, 376 are Message Of The Day (MOTD) replies

      case "CAP":
        // Client Capacity negotiation, not used by the js client

      case "353":
      case "366":
        // commands related to NAMES, not used by the js client
        break;

      case "RECONNECT":
        break;

      case "NOTICE":
        parsedMsg = merge({
          target: msgParts.params[0],
          message: msgParts.trailing
        });
        break;

      case "WHISPER":
        parsedMsg = merge({
          to: msgParts.params[0].toLowerCase(),
          message: msgParts.trailing
        });
        if (!isValidUCS2(parsedMsg.message)) {
          throw "Invalid UCS2 characters.";
        }
        break;

      case "ROOMSTATE":
        parsedMsg = merge({
          target: msgParts.params[0]
        });
        break;

      default:
        logger.warning("Could not parse IRC message: " + msgParts.command + ".");
        break;
      }

      return parsedMsg;

    } catch (e) {
      logger.error('Failed parsing IRC message "' + msgString + "'.");
      throw e;
    }
  },

  parseTmiPrivmsg: function (msg) {
    var msgString = msg.message;

    var tmiMsg = {
      tags: msg.tags,
      style: msg.style,
      target: msg.target
    };

    var parts = msgString.split(" ", 3);

    var type = parts[0];
    var user = parts[1];
    var payload = $.trim(msgString.substr((type || "").length + (user || "").length + 1));

    if (TMI_MESSAGE_TYPES.hasOwnProperty(type)) {
      var payloadConverter = null;
      switch (type) {
      case "ROOMINVITE":
        payloadConverter = function (payload) {
          return {by: payload.split(' ', 1)[0]};
        };
        break;
      default:
        payloadConverter = String;
        break;
      }

      return $.extend(tmiMsg, {
        type: type,
        user: user,
        payload: payloadConverter(payload)
      });
    } else {
      return $.extend(tmiMsg, {
        payload: msgString
      });
    }
  }
};
