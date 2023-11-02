var funnel = require('broccoli-funnel');
var watchify = require('broccoli-watchify');
var mergeTrees = require('broccoli-merge-trees');
var uglify = require('broccoli-uglify-js');

var env = process.env.BROCCOLI_ENV || 'development';
var PRODUCTION = (env === "production");
var TEST = (env === "test");
var TMI_VERSION = process.env.TMI_VERSION;

var TMIFileName = TMI_VERSION ? "tmi-v" + TMI_VERSION + ".js" : "tmi.js";

var tmiJS = watchify('src', {
  browserify: {
    entries: ['./tmi.js'],
    debug: !PRODUCTION,
    standalone: "TMI"
  },
  outputFile: TMIFileName,
  cache: true,
  init: function(b) {
    b.transform('babelify');
  }
});

var testHtml = funnel('tests/', {
  srcDir: "./",
  files: ["index.html"],
  destDir: "./"
});

var oldVersions = funnel('versions/', {
  srcDir: "./",
  destDir: "versions"
});

var staticAssets = funnel('assets/', {
  srcDir: "./",
  destDir: "assets"
});

var testSwf = funnel('assets/', {
  srcDir: "./",
  include: ['*.swf'],
  destDir: "tmilibs"
});

var JSSocketOnly = funnel(staticAssets, {
  srcDir: 'assets',
  files: ['JSSocket.swf'],
  destDir: './',
});

var include;
if (PRODUCTION) {
  tmiJS = uglify(tmiJS);

  include = [
    tmiJS,
    oldVersions,
    JSSocketOnly
  ];

} else if (TEST) {

  var testJS = watchify('tests/testJS', {
    browserify: {
      entries: ['./index.js'],
      paths: ['../../src/'],
      debug: !PRODUCTION
    },
    outputFile: "tests.js",
    cache: true,
    init: function(b) {
      b.transform('babelify');
    }
  });

  // For testing we need the HTML and iFrame
  include = [
    testHtml,
    testJS,
    tmiJS, // included so we watch for tmi changes
    testSwf,
    oldVersions,
    staticAssets
  ];

} else {

  include = [
    tmiJS,
    JSSocketOnly
  ];

}

module.exports = mergeTrees(include);
