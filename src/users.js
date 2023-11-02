/* global TMI */

import util from "./util.js";

// TODO: Storing properties for all users over the course of a long-lived connection
// might cause some issues with memory-usage. Explore techniques to reduce the memory
// footprint if it becomes an issue.
//
// TODO: Convert to ES6 class
// FIXME / NOTE:
// "staff" special doesn't seem to get sent on every message ("turbo" does, however)
var UserStore = function () {
  this._users = {};
  this._specials = new util.types.SetStore();
};

UserStore.COLORS = ["#FF0000", "#0000FF", "#008000", "#B22222", "#FF7F50", "#9ACD32",
"#FF4500", "#2E8B57", "#DAA520", "#D2691E", "#5F9EA0", "#1E90FF", "#FF69B4", "#8A2BE2", "#00FF7F"];

UserStore.prototype.setColor = function (username, color) {
  this._user(username).color = color;
};

UserStore.prototype.getColor = function (username) {
  return this._user(username).color;
};

UserStore.prototype.addSpecial = function (username, special) {
  this._specials.add(username, special);
};

UserStore.prototype.getSpecials = function (username) {
  return this._specials.get(username);
};

UserStore.prototype.getDisplayName = function (username) {
  return this._user(username).displayName;
};

UserStore.prototype.setDisplayName = function (username, displayName) {
  this._user(username).displayName = displayName;
};

UserStore.prototype._user = function (username) {
  if (!this._users[username]) {
    this._users[username] = {};
  }
  return this._users[username];
};

export default UserStore;

