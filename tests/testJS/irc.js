/* global QUnit, $ */
import irc from "irc.js";

function ircTests () {
  QUnit.module("irc");

  var parseMessageTest = function (msg, test) {
    var parsed = irc.parseMessage(msg);
    return test(parsed);
  };

  QUnit.test("parse PRIVMSG without tags", function (assert) {
    var ircMsg = ":user!user@user.tmi.twitch.tv PRIVMSG #channel :here is a message\r\n";
    parseMessageTest(ircMsg, function (parsed) {
      assert.deepEqual(parsed.tags, {});
      assert.equal(parsed.sender, "user");
      assert.equal(parsed.command, "PRIVMSG");
      assert.equal(parsed.target, "#channel");
      assert.equal(parsed.message, "here is a message");
    });
  });

  QUnit.test("parse PRIVMSG with subscriber=true turbo=false", function (assert) {
    var ircMsg = "@subscriber=1;turbo=0 :user!user@user.tmi.twitch.tv PRIVMSG #channel :here is a message\r\n";
    parseMessageTest(ircMsg, function (parsed) {
      assert.deepEqual(parsed.tags, $.extend({}, {
        subscriber: true,
        turbo: false,
      }));
      assert.equal(parsed.sender, "user");
      assert.equal(parsed.command, "PRIVMSG");
      assert.equal(parsed.target, "#channel");
      assert.equal(parsed.message, "here is a message");
    });
  });

  QUnit.test("parse PRIVMSG with emotes tag", function (assert) {
    var ircMsg = "@subscriber=1;mod=1;emotes=25:0-4,6-10/41:18-25;turbo=1 :user!user@user.tmi.twitch.tv PRIVMSG #channel :Kappa Kappa hello Kreygasm\r\n";
    parseMessageTest(ircMsg, function (parsed) {
      assert.deepEqual(parsed.tags, $.extend({}, {
        subscriber: true,
        turbo: true,
        "mod": true,
        emotes: {
          "41": [[18,25]],
          "25": [[0,4],[6,10]]
        }
      }));
      assert.equal(parsed.sender, "user");
      assert.equal(parsed.command, "PRIVMSG");
      assert.equal(parsed.target, "#channel");
      assert.equal(parsed.message, "Kappa Kappa hello Kreygasm");
    });
  });

  QUnit.test("parse PRIVMSG ACTION with emotes tag", function (assert) {
    var ircMsg = "@subscriber=1;user-type=global_mod;emotes=25:0-4,6-10/41:18-25;turbo=1 :user!user@user.tmi.twitch.tv PRIVMSG #channel :\u0001ACTION Kappa Kappa hello Kreygasm\u0001\r\n";
    parseMessageTest(ircMsg, function (parsed) {
      assert.deepEqual(parsed.tags, $.extend({}, {
        subscriber: true,
        turbo: true,
        "user-type": "global_mod",
        emotes: {
          "41": [[18,25]],
          "25": [[0,4],[6,10]]
        }
      }));
      assert.equal(parsed.sender, "user");
      assert.equal(parsed.command, "PRIVMSG");
      assert.equal(parsed.target, "#channel");
      assert.equal(parsed.action, "Kappa Kappa hello Kreygasm");
    });
  });

  QUnit.test("parse PRIVMSG with extra UCS2 code points and emotes", function (assert) {
    var ircMsg = "@emotes=25:0-4,12-16,22-26,34-38;mod=1;display-name= :user!user@user.tmi.twitch.tv PRIVMSG #channel :Kappa 🚌 bus Kappa bus Kappa bus 🚌 Kappa\r\n";
    parseMessageTest(ircMsg, function (parsed) {
      assert.deepEqual(parsed.tags, $.extend({}, {
        "mod": true,
        "display-name": "",
        "emotes": {
          "25": [[0,4],[13,17],[23,27],[36,40]]
        },
      }));
      assert.equal(parsed.sender, "user");
      assert.equal(parsed.command, "PRIVMSG");
      assert.equal(parsed.target, "#channel");
      assert.equal(parsed.message, "Kappa 🚌 bus Kappa bus Kappa bus 🚌 Kappa");
    });
  });

  QUnit.test("parse PRIVMSG ACTION with extra UCS2 code points and emotes", function (assert) {
    var ircMsg = "@emotes=25:0-4,12-16,22-26,34-38;mod=1;display-name= :user!user@user.tmi.twitch.tv PRIVMSG #channel :\u0001ACTION Kappa 🚌 bus Kappa bus Kappa bus 🚌 Kappa\u0001\r\n";
    parseMessageTest(ircMsg, function (parsed) {
      assert.deepEqual(parsed.tags, $.extend({}, {
        "mod": true,
        "display-name": "",
        "emotes": {
          "25": [[0,4],[13,17],[23,27],[36,40]]
        },
      }));
      assert.equal(parsed.sender, "user");
      assert.equal(parsed.command, "PRIVMSG");
      assert.equal(parsed.target, "#channel");
      assert.equal(parsed.action, "Kappa 🚌 bus Kappa bus Kappa bus 🚌 Kappa");
    });
  });

  QUnit.test("parse USERNOTICE with tags", function (assert) {
    var ircMsg = "@msg-id=resub;msg-param-months=6;login=mom;system-msg=Mom\\shas\\ssubscribed\\sfor\\s6\\smonths! :tmi.twitch.tv USERNOTICE #goldenkappa4ever :I support you\r\n";

    parseMessageTest(ircMsg, function (parsed) {
      assert.deepEqual(parsed.tags, {
        "msg-id": "resub",
        "msg-param-months": "6",
        "system-msg": "Mom has subscribed for 6 months!",
        "login": "mom",
      });
      assert.equal(parsed.sender, "mom");
      assert.equal(parsed.command, "USERNOTICE");
      assert.equal(parsed.target, "#goldenkappa4ever");
      assert.equal(parsed.message, "I support you");
    });
  });

  QUnit.test("parse USERSTATE command", function (assert) {
    var ircMsg = "@subscriber=1;user-type=global_mod;emote-sets=0,10,3012,83;turbo=1 :tmi.twitch.tv USERSTATE #channel\r\n";
    parseMessageTest(ircMsg, function (parsed) {
      assert.deepEqual(parsed.tags, $.extend({}, {
        subscriber: true,
        turbo: true,
        "user-type": "global_mod",
        "emote-sets": "0,10,3012,83"
      }));
      assert.equal(parsed.prefix, "tmi.twitch.tv");
      assert.equal(parsed.command, "USERSTATE");
      assert.equal(parsed.target, "#channel");
    });

  });

  QUnit.test("parse escaped characters in tags", function (assert) {
    var ircMsg = "@tag1=Bunny\\\\rabbit;tag2=semi\\:colon;tag3=sp\\sace;tag4=c\\rr;tag5=new\\nline :user!user@user.tmi.twitch.tv PRIVMSG #channel :here is a message\r\n";
    parseMessageTest(ircMsg, function (parsed) {
      assert.equal(parsed.tags.tag1,"Bunny\\rabbit");
      assert.equal(parsed.tags.tag2,"semi;colon");
      assert.equal(parsed.tags.tag3,"sp ace");
      assert.equal(parsed.tags.tag4,"c\rr");
      assert.equal(parsed.tags.tag5,"new\nline");
    });
  });

  QUnit.test("parse improperly escaped characters in tags", function (assert) {
    var ircMsg = "@tag1=Slash\\;tag2=Sl\\ash :user!user@user.tmi.twitch.tv PRIVMSG #channel :here is a message\r\n";
    parseMessageTest(ircMsg, function (parsed) {
      assert.equal(parsed.tags.tag1,"");
      assert.equal(parsed.tags.tag2,"");
    });
  });
}

export default ircTests;
