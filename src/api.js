/* global TMI, Twitch, $ */

import Logging from "./log.js";
import util from "./util.js";

var logger = Logging._getLogger("api");

var DEFAULT_MAX_GET_ATTEMPTS = 3;

class Api {
  constructor (config) {
    this.baseUrl = config.baseUrl;
    this.data = config.data;
    this.headers = config.headers;
  }

  get (path, data, options) {
    return this._ajaxRetry('GET', path, data, options);
  }

  post (path, data, options) {
    return this._ajaxRetry('POST', path, data, options);
  }

  put (path, data, options) {
    return this._ajaxRetry('PUT', path, data, options);
  }

  del (path, data, options) {
    return this._ajaxRetry('DELETE', path, data, options);
  }

  destroy() {
    $(this.iframe).remove();
  }

  _initIframeHack (receiverUrl, documentDomain) {
    this._isIframeHackReady = false;
    this.requestQueue = [];
    // Use an iframe trick to allow us to communicate to
    // cross-domain api urls by setting document.domain on
    // both the parent and iframe, then using the iframe's
    // internal XHR object
    this.iframe = $('<iframe>')
      .attr('src', receiverUrl)
      .appendTo('head')
      .get(0);
    // Allow us to talk to the iframe
    document.domain = documentDomain;
  }

  _iframeHackAjax (options) {
    options.xhr = () => {
      // Key to the magic: grab the XHR object of the child iframe that has
      // its location on the api domain, so any XHR requests are considered
      // to be part of the same domain.
      // https://github.com/jquery/jquery/blob/7c23b77af2477417205fda9bde5208a81e57e40e/src/ajax/xhr.js#L26
      // Don't support ActiveXObject because we don't need local file support
      // Also check Twitch.api.xhrConstructor to allow stubbing in tests.
      let XhrConstructor = Twitch.api.xhrConstructor || this.iframe.contentWindow.XMLHttpRequest;

      return new XhrConstructor();
    };
    options.beforeSend = function (jqXHR, settings) {
      // jQuery incorrectly thinks this is a crossdomain request,
      // and tries to prevent it from sending on browsers that do not
      // support CORS (IE9). Since we know better, tell jQuery.
      settings.crossDomain = false;
    };

    if (this._isIframeHackReady) {
      $.ajax(options);
    } else {
      logger.debug("API Iframe hack not ready. Queueing " + options.method + " " + options.url + " API request.");
      this.requestQueue.push(options);
    }
  }

  _onIframeHackReady () {
    if (!this._isIframeHackReady) {
      this._isIframeHackReady = true;
      $.each(this.requestQueue, function (index, options) {
        $.ajax(options);
      });
    }
  }

  _ajaxRetry (method, path, data, options) {
    // retries failed ajax calls automatically
    var deferred = new $.Deferred();
    options = options || {};
    if (options.success) {
      deferred.done(options.success);
      delete options.success;
    }
    if (options.error) {
      deferred.fail(options.error);
      delete options.error;
    }

    if (method === 'GET') {
      options.numAttempts = options.numAttempts || DEFAULT_MAX_GET_ATTEMPTS;
    } else {
      options.numAttempts = options.numAttempts || 1;
    }

    deferred.fail(function (jqXHR, textStatus, errorThrown) {
      TMI._trigger('api-fail', {
        url: options.url,
        jqXHR: jqXHR,
        textStatus: textStatus,
        errorThrown: errorThrown
      });
    });

    options.headers = $.extend({}, this.headers, options.headers);
    options.data = $.extend({}, this.data, data, options.data);

    if (this.data && this.data.oauth_token) {
      options.headers.Authorization = 'OAuth ' + this.data.oauth_token;
    }

    var contentType = options.headers['Content-Type'];
    if (contentType && contentType.includes('application/json')) {
      options.data = JSON.stringify(options.data);
    }

    options.type = options.type || method;

    options = $.extend({
      url: this.baseUrl + path,
      dataType: "json",
      cache: true,
      global: false,
      retryNum: 0,
      reject: deferred.reject,
      success: deferred.resolve
    }, options);

    this._doAjax(options);
    return deferred;
  }

  _doAjax (options) {
    var self = this;
    if (options.numAttempts === 1) {
      options.error = function (jqXHR, textStatus, errorThrown) {
        options.reject(jqXHR, textStatus, errorThrown);
      };
    } else {
      options.error = function () {
        options.numAttempts--;
        var retryDelay = util.time.seconds(Math.pow(2, options.retryNum)) / 2;
        setTimeout(() => { self._doAjax(options); }, retryDelay);
        options.retryNum++;
        logger.warning("ajax error, retrying in " + retryDelay + " milliseconds...");
      };
    }

    if (this.iframe) {
      this._iframeHackAjax(options);
    } else {
      $.ajax(options);
    }
  }
}

var api = {};

api.twitch = {};

api.twitch.init = function (opts) {
  opts = opts || {};
  var host = opts.hostport || "api.twitch.tv";

  var baseUrl = window.location.protocol + '//' + host;
  var api = new Api({
    baseUrl: baseUrl,
    data: {
      oauth_token: opts.oauthToken
    },
    headers: {
      Accept: 'application/vnd.twitchtv.v4+json',
      'Twitch-Api-Token': util.readCookie('api_token'),
      'Client-ID': 'jzkbprff40iqj646a697cyrvl0zt2m6' // web-client's client id
    }
  });

  // Called by receiver iframe to trigger any pending requests
  window.TMI._twitchIframeReady = function () {
    api._onIframeHackReady();
  };
  api._initIframeHack(baseUrl + '/assets/tmi_crossdomain_receiver.html', 'twitch.tv');

  return api;
};

api.twitch.getAcceptHeader = function (version) {
  return 'application/vnd.twitchtv.v' + version + '+json';
};

api.chatdepot = {};

api.chatdepot.init = function (oauthToken) {
  var baseUrl = "chatdepot.twitch.tv";

  var WHITELIST = ["chatdepot-staging.twitch.tv"];
  var url = util.urlParams.chatdepot_api_url;
  if (url) {
    if (WHITELIST.indexOf(url) < 0) {
      var error = "Non-whitelisted chatdepot_api_url: " + url;
      logger.error(error);
      throw error;
    }
    baseUrl = util.urlParams.chatdepot_api_url;
  }

  baseUrl = window.location.protocol + "//" + baseUrl;
  var api = new Api({
    baseUrl: baseUrl,
    data: {
      oauth_token: oauthToken
    }
  });

  // Called by receiver iframe to trigger any pending requests
  window.TMI._api = {
    iframeReady: function () {
      api._onIframeHackReady();
    }
  };
  api._initIframeHack(baseUrl + '/crossdomain/tmi.html', 'twitch.tv');

  return api;
};

api.chatdepot.fail = function (deferred) {
  return function (jqXHR, textStatus, errorThrown) {
    var errorCode,
        errors,
        message;

    try {
      var response = JSON.parse(jqXHR.responseText);
      errorCode = response.code;
      errors = response.errors;
      message = response.message;
    } catch (e) {
      logger.warning("Unable to parse body of error response.");
    }

    logger.error("Depot responded with: " + errorCode + " - " + message);
    deferred.reject(errorCode, message, errors);
  };
};

api.tmi = {};

api.tmi.init = function (oauthToken) {
  var baseUrl = window.location.protocol + '//tmi.twitch.tv';

  var api = new Api({
    baseUrl: baseUrl,
    data: {
      oauth_token: oauthToken
    }
  });

  // Called by receiver iframe to trigger any pending requests
  window.TMI._tmiIframeReady = function () {
    api._onIframeHackReady();
  };
  api._initIframeHack(baseUrl + '/static/crossdomain_receiver.html', 'twitch.tv');

  return api;
};

api.tmi.fail = function (deferred) {
  return function (jqXHR, textStatus, errorThrown) {
    logger.error("TMI api error: " + jqXHR.statusCode() + ", " + textStatus + ", " + errorThrown);
    deferred.reject();
  };
};

export default api;
