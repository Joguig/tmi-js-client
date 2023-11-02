/* global $ */

var statsBase = "https://client-event-reporter-darklaunch.twitch.tv";

var stats = {};

stats.sendStatCounter = function (key) {
  $.ajax({
    type: "POST",
    url: statsBase + "/counter",
    data: {
      "key": key,
      "count":"1"
    }
  });
};

stats.sendStatTimer = function (key, ms) {
  $.ajax({
    type: "POST",
    url: statsBase + "/timer",
    data: {
      "key": key,
      "milliseconds": ms
    }
  });
};

stats.sendStatLogger = function (line) {
  $.ajax({
    type: "POST",
    url: statsBase + "/logger",
    data: {
      "log_line": line
    }
  });
};

export default stats;
