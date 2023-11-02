/* global QUnit */

import RateCounter from "RateCounter.js";

function timeAccumulatorTests () {
  QUnit.module("rate-counter");

  QUnit.test("Default rate is 0", function (assert) {
    var counter = new RateCounter();
    assert.equal(counter.getRateForSecond(), 0);
    assert.equal(counter.getRatePerSecondForLastSeconds(60), 0);
  });

  QUnit.test("Adding to an empty buffer should set rate", function (assert) {
    var counter = new RateCounter();
    counter.add();
    assert.equal(counter.getRateForSecond(), 1);
    assert.equal(counter.getRatePerSecondForLastSeconds(60), (1/60));
  });

  QUnit.test("Adding multiple to an empty buffer should set rate", function (assert) {
    var counter = new RateCounter();
    counter.add(60);
    assert.equal(counter.getRateForSecond(), 60);
    assert.equal(counter.getRatePerSecondForLastSeconds(60), 1);
  });
  
  QUnit.test("Adding every second will keep rate at 1", function (assert) {
    var done = assert.async();

    var counter = new RateCounter();
    counter.add();
    assert.equal(counter.getRateForSecond(), 1);
    setTimeout(function() {
      counter.add();
      assert.equal(counter.getRateForSecond(), 1);
      done();
    }, 1000);
  });
}

export default timeAccumulatorTests;
