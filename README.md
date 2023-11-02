TMI JS Client
===

### Development

#### Dependencies
These are the prerequisites expected to be on your machine to build the application
* Git
* Node.js (With NPM)
* JSCS
* Python

#### Building

Building can be accomplished by running
* `make build` will output the built files once
* `make watch` will watch for file changes and continously build

These will output built versions of `tmi-v3.js` and `JSSocket.swf` to `/deploy/dist/build`

These outputted files can be used in a local rails instance by then running
`make link WEB=[./PATH/TO/WEB/REPO]`

#### Testing

There are some tests supplied for the JS application which can be run with:
`make test`

This will create a web server that will use your built js to run its tests when you visit:

[http://localhost.twitch.tv:4000](http://localhost.twitch.tv:4000/?tmi_host=tmi-darklaunch-7db8c8.sfo01.justin.tv&tmi_port=6667&tmi_log_level=debug)

#### Local Development

You can serve the files locally by running a broccoli server.
 - `broccoli serve` or, broccoli is not on your path, `node_modules/.bin/broccoli serve`

If you're developing `web-client` locally, you can change the line `<script src ="{{CDN_HOSTPORT}}/tmilibs/tmi-v3.js"></script>` in `index.html` to fetch `http://localhost:4200/tmi.js`.