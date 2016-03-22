var url          = require('url')
  , zlib         = require('zlib')
  , Agent        = require('agentkeepalive')
  , superagent   = require('superagent').agent()
  , Serializer   = require('./serializer')
  , Deserializer = require('./deserializer')
  , Cookies      = require('./cookies');

/**
 * Creates a Client object for making XML-RPC method calls.
 *
 * @constructor
 * @param {Object|string} options - Server options to make the HTTP request to.
 *                                  Either a URI string
 *                                  (e.g. 'http://localhost:9090') or an object
 *                                  with fields:
 *   {string} options.host              - (optional)
 *   {number} options.port
 *   {string} options.url               - (optional) - may be used instead of host/port pair
 *   {boolean} options.cookies          - (optional) - if true then cookies returned by server will be stored and sent back on the next calls.
 *   {number} options.keepAlive         - (optional) - Keep Alive Miliseconds, set to 0 to disable.
 *   {string} options.gzip              - (optional) - GZip compression, default false. 'response' or 'both', both is sending and receiving (kind of forcing)
 *   {string} options.userAgent         - (optional) - Custom User-Agent.
 *                                  Also it will be possible to access/manipulate cookies via #setCookie/#getCookie methods
 * @param {boolean} isSecure      - True if using https for making calls,
 *                                  otherwise false.
 * @return {Client}
 */
function Client(options, isSecure) {

  // Invokes with new if called without
  if (false === (this instanceof Client)) {
    return new Client(options, isSecure)
  }

  // If a string URI is passed in, converts to URI fields
  if (typeof options === 'string') {
    options = url.parse(options)
    options.host = options.hostname
    options.path = options.pathname
  }

  if (typeof options.url !== 'undefined') {
    var parsedUrl = url.parse(options.url);
    options.host = parsedUrl.hostname;
    options.path = parsedUrl.pathname;
    options.port = parsedUrl.port;
  }

  if (! options.host) {
    options.host = 'localhost';
  }
  if (! options.port) {
    options.port = (isSecure ? 443 : 80);
  }
  if (! options.path) {
    options.path = '/';
  }
  if (options.path && options.path.charAt(0) !== '/') {
    options.path = '/' + options.path;
  }
  options.keepAlive = options.keepAlive || 0;
  options.gzip      = options.gzip || false;

  options.url       = (isSecure ? 'https://' : 'http://') + options.host + ':';
  options.url      += options.port + options.path;

  // Set the HTTP request headers
  var headers = {
    'User-Agent'     : options.userAgent || 'NodeJS XML-RPC Client/' + require('./../package').version
  , 'Content-Type'   : 'text/xml'
  , 'Accept'         : 'text/xml'
  , 'Accept-Charset' : 'UTF8'
  , 'Connection'     : 'Keep-Alive'
};

  // Compression Header.
  if (options.gzip) {
    headers['Accept-Encoding'] = 'gzip';
  }
  if (options.gzip === 'both') {
    // Also encode request!
    headers['Content-Encoding'] = 'gzip';
  }

  options.headers = options.headers || {};

  if (options.headers.Authorization == null &&
      options.basic_auth != null &&
      options.basic_auth.user != null &&
      options.basic_auth.pass != null)
  {
    var auth = options.basic_auth.user + ':' + options.basic_auth.pass;
    options.headers['Authorization'] = 'Basic ' + new Buffer(auth).toString('base64');
  }

  for (var attribute in headers) {
    if (options.headers[attribute] === undefined) {
      options.headers[attribute] = headers[attribute];
    }
  }

  options.method = 'POST';
  this.options = options;

  this.isSecure = isSecure;
  this.headersProcessors = {
    processors: [],
    composeRequest: function(headers) {
      this.processors.forEach(function(p) {p.composeRequest(headers);});
    },
    parseResponse: function(headers) {
      this.processors.forEach(function(p) {p.parseResponse(headers);});
    }
  };
  if (options.cookies) {
    this.cookies = new Cookies();
    this.headersProcessors.processors.unshift(this.cookies);
  }

  var agentOptions = {
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 3000
  };

  if (options.keepAlive > 0) {
    agentOptions.timeout = options.keepAlive + 10000;
    agentOptions.keepAliveTimeout = options.keepAlive;
  }
  this.agent = new Agent(agentOptions);
}

/**
 * Makes an XML-RPC call to the server specified by the constructor's options.
 *
 * @param {String} method     - The method name.
 * @param {Array} params      - Params to send in the call.
 * @param {Function} callback - function(error, value) { ... }
 *   - {Object|null} error    - Any errors when making the call, otherwise null.
 *   - {mixed} value          - The value returned in the method response.
 */
Client.prototype.methodCall = function methodCall(method, params, callback) {
  var self      = this;
  var options   = this.options;
  var xml       = Serializer.serializeMethodCall(method, params, options.encoding);

  this.headersProcessors.composeRequest(options.headers);

  var request = superagent.post(options.url);
  request.set(options.headers);
  request.agent(this.agent);

  if (options.gzip && options.gzip === 'both') {
    zlib.gzip(xml, function (err, buffer) {
      request.set('Content-Length', buffer.length);
      request.send(buffer);
    });
  } else {
    request.set('Content-Length', Buffer.byteLength(xml, 'utf8'));
    request.send(xml);
  }

  var ended = false;
  request.on('error', function (err) {
    if (! ended) {
      ended = true;
      callback(err);
    }
  });
  request.on('end', function () {
    ended = true;
    if (this.err) {
      return callback(this.err);
    }
    if (this.res.statusCode == 404) {
      return callback(new Error('Not Found'));
    }
    self.headersProcessors.parseResponse(this.res.headers);
  });

  var deserializer = new Deserializer(options.responseEncoding);
  deserializer.deserializeMethodResponse(request, function(err, result) {
    if (ended) { return callback(err, result); }
    request.on('end', function() {
      callback(err, result);
    });
  });
}

/**
 * Gets the cookie value by its name. The latest value received from servr with 'Set-Cookie' header is returned
 * Note that method throws an error if cookies were not turned on during client creation (see comments for constructor)
 *
 * @param {String} name name of the cookie to be obtained or changed
 * @return {*} cookie's value
 */
Client.prototype.getCookie = function getCookie(name) {
  if (!this.cookies) {
    throw 'Cookies support is not turned on for this client instance';
  }
  return this.cookies.get(name);
}

/**
 * Sets the cookie value by its name. The cookie will be sent to the server during the next xml-rpc call.
 * The method returns client itself, so it is possible to chain calls like the following:
 *
 * <code>
 *   client.cookie('login', 'alex').cookie('password', '123');
 * </code>
 *
 * Note that method throws an error if cookies were not turned on during client creation (see comments for constructor)
 *
 * @param {String} name name of the cookie to be changed
 * @param {String} value value to be set.
 * @return {*} client object itself
 */
Client.prototype.setCookie = function setCookie(name, value) {
  if (!this.cookies) {
    throw 'Cookies support is not turned on for this client instance';
  }
  this.cookies.set(name, value);
  return this;
}

module.exports = Client
