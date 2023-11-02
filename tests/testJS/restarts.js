/* global QUnit */
import TMI from "tmi.js";

function restartsTests () {
  var ROOM = 'don_quixotic';

  var SESSION_CONFIG_1 = {
    userId: 41298922,
    username: "don_quixotic",
    oauthToken: "9moyhq2aaac5gkf6wka17khgkyb6vd9"
  };

  var SESSION_CONFIG_2 = {
    userId: 32971812,
    username: "mattyurka",
    oauthToken: "hs409cvp1k6niuns6blrxs4nl8t7blx"
  };

  var Counter = function () {
    this.counts = {};
  };

  Counter.prototype.incr = function (key) {
    this.counts[key] = this.counts[key] || 0;
    this.counts[key]++;
  };

  var session1, session2, session3;

  QUnit.module("restarts", {
    setup: function () {
      session1 = TMI.createSession(SESSION_CONFIG_1);
      session2 = TMI.createSession(SESSION_CONFIG_2);
      session3 = TMI.createSession(SESSION_CONFIG_2);
    },
    teardown: function () {
      session1.destroy();
      session1 = undefined;
      session2.destroy();
      session2 = undefined;
      session3.destroy();
      session3 = undefined;
    }
  });

  QUnit.asyncTest("reconnect", function (assert) {
    var room1, room2, room3;
    var room1EnteredDef = $.Deferred(),
    room2EnteredDef = $.Deferred(),
    room3EnteredDef = $.Deferred();

    var sendingTimeoutId;
    session1.getRoom(ROOM).done(function (room) {
      room1 = room;
      room1.on('entered', function () {
        var messageIndex = 1;
        var send = function () {
          room1.sendMessage("message " + messageIndex);
          messageIndex += 1;
          sendingTimeoutId = setTimeout(send, 100);
        };
        send();
      });
      room1.on('entered', function () { room1EnteredDef.resolve(); });
      room1.enter();
    });

    var counter2 = new Counter();
    var oldConn;
    session2.getRoom(ROOM).done(function (room) {
      oldConn = room._roomConn._connection;

      room._logEvents = true;
      room2 = room;
      room2.on('entered', function () { room2EnteredDef.resolve(); });
      room2.on('message', function (ircMsg) {
        if (ircMsg.message.indexOf('unable to connect to chat') > -1) return;
        counter2.incr(ircMsg.from + '|' + ircMsg.message);
        ircMsg.date = undefined;
      });
      room2.enter();
    });

    var counter3 = new Counter();
    session3.getRoom(ROOM).done(function (room) {
      room3 = room;
      room3.on('entered', function () { room3EnteredDef.resolve(); });
      room3.on('message', function (ircMsg) {
        if (ircMsg.message.indexOf('unable to connect to chat') > -1) return;
        counter3.incr(ircMsg.from + '|' + ircMsg.message);
        ircMsg.date = undefined;
      });
      room3.enter();
    });

    $.when(room1EnteredDef, room2EnteredDef, room3EnteredDef).done(function () {
      room2._roomConn._connection._socket._onEvent({
        event: "data",
        data: "%3Atmi.twitch.tv%20RECONNECT%0D%0A"
      });
      setTimeout(forceDisconnect, 30000);
    });

    var forceDisconnect = function () {
      oldConn._socket._onEvent({
        event: "closed"
      });
      setTimeout(stopSending, 1000);
    };

    var stopSending = function () {
      clearTimeout(sendingTimeoutId);
      setTimeout(complete, 1000);
    };

    var complete = function () {
      var newConn = room2._roomConn._connection;
      assert.notStrictEqual(newConn, oldConn, 'New connection instance');
      assert.deepEqual(counter2.counts, counter3.counts, 'Room message event counts match');
      assert.ok(!oldConn._reconnecting, 'Old connection not reconnecting');
      assert.ok(!newConn._reconnecting, 'New connection not reconnecting');
      assert.ok(!oldConn.isActive, 'Old connection not active');
      QUnit.start();
    };
  });
}

export default restartsTests;
