import logging from "./log.js";

var logger = logging._getLogger("RateCounter");

/**
 RateCounter :
 Works as a counter with second granularity bucketing.
 Uses a sparse circular buffer with a default of 90 buckets.
 **/
class RateCounter {
  constructor (opts) {
    opts = opts || {};
    this._size = opts.size || 90;
    this._times = new Array(this._size);
    this._values = new Array(this._size);

    this._initializeState();
  }

  _initializeState () {
    this._cursor = 0;

    var initTime = this._getTimeInSeconds();
    for (var i = 0; i < this._size; i++) {
      this._values[i] = 0;
      this._times[i] = initTime;
    }
  }

  _getTimeInSeconds () {
    return Math.floor(Date.now() / 1000);
  }

  _incrementCursor () {
    this._cursor = (this._cursor + 1) % this._size;
    return this._cursor;
  }

  _timeHead () {
    return this._times[this._cursor];
  }

  // Main method for adding to the counter of the current bucket
  add (count) {
    count = count || 1;
    var time = this._getTimeInSeconds();
    if (time > this._timeHead()) {
      this._incrementCursor();
      this._values[this._cursor] = count;
      this._times[this._cursor] = time;
    } else if (time < this._timeHead()) {
      logger.error("Time ran backwards (local clock likely changed)");
      this._initializeState();
      this._values[this._cursor] += count;
    } else {
      this._values[this._cursor] += count;
    }
  }

  // Returns the count of the bucket that matches the given time.
  getRateForSecond (time) {
    time = time || this._getTimeInSeconds();

    // Walk backwards around ciruclar buffer
    for (var i = this._size; i > 0; i--) {
      var idx = (i + this._cursor) % this._size;
      if (time === this._times[idx]) {
        return this._values[idx];
      } else if (time > this._times[idx]) {
        // Passed it without match, no entry.
        return 0;
      }
    }

    // No match, and no time in buffer less than passed time, therefore we
    // don't have this value in buffer.
    return 0;
  }

  getRatePerSecondForLastSeconds (seconds) {
    var time = this._getTimeInSeconds() - 1;
    var startTime = time - seconds;

    var sum = 0;
    for (var i = this._size; i > 0; i--) {
      var idx = (i + this._cursor) % this._size;
      if (this._times[idx] >= startTime) {
        sum += this._values[idx];
      } else {
        return sum / seconds;
      }
    }

    // If we didn't short circuit it means we didn't have {seconds} seconds worth of
    // history.  Assume 0s for all non tracked bucketsbefore that
    return sum / seconds;
  }
}

export default RateCounter;
