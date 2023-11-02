
class EventsDispatcher {
  on (name, callback, context) {
    this._events = this._events || {};
    this._events[name] = this._events[name] || [];
    this._events[name].push(callback, context);
    return this;
  }

  off (name, callback) {
    if (this._events) {
      var callbacks = this._events[name] || [];
      var keep = this._events[name] = [];
      for (var i = 0; i < callbacks.length; i += 2) {
        if (callbacks[i] !== callback) {
          keep.push(callbacks[i]);
          keep.push(callbacks[i + 1]);
        }
      }
    }
    return this;
  }

  _trigger (name) {
    if (this._events) {
      var callbacks = this._events[name] || [];
      for (var i = 1; i < callbacks.length; i += 2) {
        callbacks[i - 1].apply(callbacks[i], Array.prototype.slice.call(arguments, 1));
      }
    }
    return this;
  }
}

export default EventsDispatcher;
