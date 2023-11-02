/* global QUnit */

import Room from "room.js";

function roomTests() {
  QUnit.module("room");

  let mockConnection = {
    _addRoomConn() {},
    on() {},
  };

  let mockSession = {
    _users: {
      getSpecials() {
        return [];
      }
    }
  };

  function newRoom() {
    return new Room({
      chattersListUrl: "//tmi.twitch.tv/group/user/mock/chatters",
      connection: mockConnection,
      name: "mock-name",
      ownerId: 99999999,
      session: mockSession,
      whisperConn: mockConnection,
    });
  }

  QUnit.test("default labels", function(assert) {
    let room = newRoom();
    let labels = room.getLabels("mock-user");
    assert.deepEqual(labels, []);
  });

  /**
   * Labels
   */

  QUnit.test("user is modded", function(assert) {
    let room = newRoom();

    room._updateUserState("mock-user", { mod: true });

    let labels = room.getLabels("mock-user");
    assert.deepEqual(labels, ["mod"]);
  });

  QUnit.test("user is modded then demodded", function(assert) {
    let room = newRoom();

    room._updateUserState("mock-user", { mod: true });
    room._updateUserState("mock-user", { mod: false });

    let labels = room.getLabels("mock-user");
    assert.deepEqual(labels, []);
  });

  QUnit.test("user subscribes", function(assert) {
    let room = newRoom();

    room._updateUserState("mock-user", { subscriber: true });

    let labels = room.getLabels("mock-user");
    assert.deepEqual(labels, ["subscriber"]);
  });

  QUnit.test("user subscribes then unsubscribes", function(assert) {
    let room = newRoom();

    room._updateUserState("mock-user", { subscriber: true });
    room._updateUserState("mock-user", { subscriber: false });

    let labels = room.getLabels("mock-user");
    assert.deepEqual(labels, []);
  });

  /**
   * Badges
   */
  QUnit.test("user has no badges", function(assert) {
    let room = newRoom();

    let badges = room.getBadges("mock-user");
    assert.deepEqual(badges, {});
  });

  QUnit.test("user turns on horde badge", function(assert) {
    let room = newRoom();

    room._updateUserState("mock-user", { _badges: [{id: "horde", version: "1"}] });

    let badges = room.getBadges("mock-user");
    assert.deepEqual(badges, {"horde": "1"});
  });

  QUnit.test("badge version changes", function(assert) {
    let room = newRoom();

    room._updateUserState("mock-user", { _badges: [{id: "horde", version: "1"}] });
    room._updateUserState("mock-user", { _badges: [{id: "horde", version: "2"}] });

    let badges = room.getBadges("mock-user");
    assert.deepEqual(badges, {"horde": "2"});
  });

  QUnit.test("user toggles horde badge", function(assert) {
    let room = newRoom();

    room._updateUserState("mock-user", { _badges: [{id: "horde", version: "1"}] });
    room._updateUserState("mock-user", []);

    let badges = room.getBadges("mock-user");
    assert.deepEqual(badges, {});
  });
}

export default roomTests;
