# node-serviceworker-proxy
A proxy service running serviceworker code on behalf of clients without native support. Based on [node-serviceworker](https://github.com/gwicke/node-serviceworker).

Background:

- [Page composition using service workers and server-side JS fall-back](https://phabricator.wikimedia.org/T106099)
- [API driven web front-end](https://phabricator.wikimedia.org/T111588)

## Demo

A demo service is running at https://swproxy.wmflabs.org/wiki/Foobar. This is
serving a demo [streaming
serviceworker](https://github.com/gwicke/streaming-serviceworker-playground/blob/master/lib/sw.js),
which composes templates and streamed HTML content using
[web-stream-util](https://github.com/wikimedia/web-stream-util) and
[web-html-stream](https://github.com/wikimedia/web-html-stream).
