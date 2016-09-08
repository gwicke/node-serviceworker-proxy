'use strict';

const path = require('path');
const querystring = require('querystring');
const stream = require('stream');
const P = require('bluebird');
const FormData = require('form-data');

const ServiceWorkerContainer = require('node-serviceworker');
const fetch = require('node-fetch-polyfill');
const Request = fetch.Request;
const isNodeStream = require('is-stream');


class ServiceWorkerProxy {
    constructor(options) {
        this._options = options;
        this._swcontainer = new ServiceWorkerContainer();
        this._registrationScripts = {};
    }

    /**
     * Install / refresh ServiceWorkers for a given domain
     *
     * Uses registration.paths to fetch a JSON blob with a mapping from scope
     * to serviceworker URL, and installs those serviceworkers in the
     * container.
     */
    refreshWorkersForDomain(domain) {
        const url = 'https://' + path.join(domain, this._options.registration.paths[0]);
        return fetch(url)
            // TODO: check return status / use higher level wrapper that maps
            // errors to throw().
            .then(res => {
                if (res.status !== 200) {
                    // HACK
                    return [{
                        scope: '/',
                        scriptURL: 'https://en.wikipedia.org/w/index.php?title=User:GWicke/sw.js&action=raw&ctype=text/javascript',
                        online: true
                    }];
                    // throw new Error(`Registration fetch for ${domain} failed`);
                }
                res.json();
            })
            .then(mappings => {
                // Remove all registrations for this domain
                this._swcontainer.x_clearDomain(domain);
                this._registrationScripts[domain] = '';
                // scope -> url
                return P.each(mappings, mapping => {
                    return this._swcontainer.register(mapping.scriptURL, mapping)
                    .then(() => {
                        this._registrationScripts[domain] += '\nif (navigator.serviceWorker) { navigator.serviceWorker.register('
                                + JSON.stringify('/__sw_'
                                    // Use base64 encoding to avoid escaping
                                    // security restrictions for SW URLs.
                                    + new Buffer(mapping.scope).toString('base64'))
                                + ', { scope: ' + JSON.stringify(mapping.scope) + ' }); }';
                    });
                });
            });
    }

    convertHeaders(headers) {
        const res = {};
        headers.forEach((value, key) => {
            res[key] = value;
        });
        delete res['content-encoding'];
        return res;
    }

    _hackyHostRewrite(host) {
        if (/^localhost:?/.test(host) || host === 'swproxy.wmflabs.org') {
            return 'en.wikipedia.org';
        } else {
            return host;
        }
    }

    _addRegisterScripts(domain, body) {
        const registrationScripts = this._registrationScripts[domain];
        if (registrationScripts) {
            const scriptBuffer = new Buffer('<script>' + registrationScripts + '</script>');
            // Inject a ServiceWorker registration at the end of the HTML.
            if (isNodeStream(body)) {
                // Append a stream
                const concatStream = new stream.PassThrough();
                body.on('data', chunk => concatStream.write(chunk));
                body.on('end', () => concatStream.end(scriptBuffer));
                body = concatStream;
            } else {
                if (!Buffer.isBuffer(body)) {
                    body = new Buffer('' + body);
                }
                return Buffer.concat([body, scriptBuffer]);
            }
            return body;
        }
        return body;
    }

    // Convert a hyperswitch request to a `fetch` Request object.
    _makeRequest(req) {
        // Append the query string
        req.uri += Object.keys(req.query).length ?
            '?' + querystring.stringify(req.query) : '';

        if (req.method === 'post'
                && /urlencoded|multi-part/.test(req.headers['content-type'])
                && typeof body === 'object') {
            // Convert body to FormData instance
            const formData = new FormData();
            Object.keys(req.body).forEach(key => {
                formData.append(key, req.body[key]);
            });
            req.body = formData;
            Object.assign(req.headers, formData.getHeaders());
        }
        return new Request(req.uri, {
            method: req.method,
            headers: req.headers,
            body: req.body
        });
    }

    proxyRequest(hyper, req) {
        const domain = req.headers.host = this._hackyHostRewrite(req.headers.host);
        const rp = req.params;

        if (/^__sw_/.test(rp.path)) {
            // Request for a ServiceWorker
            return this.swRequest(req, domain);
        }


        let setupPromise = P.resolve();
        if (!this._swcontainer._registrations.get(domain)) {
            // First, install workers for this domain.
            setupPromise = this.refreshWorkersForDomain(domain);
            // Refresh registrations every two minutes.
            setInterval(this.refreshWorkersForDomain.bind(this, domain),
                    this._options.registration.refresh_interval_seconds * 1000);
        }

        req.uri = 'https://' + domain + '/' + req.params.path;
        const request = this._makeRequest(req);
        return setupPromise
            .then(() => this._swcontainer.getRegistration(req.uri))
            .then(registration => {
                if (registration) {
                    // Request is handled by a ServiceWorker.
                    return registration.fetch(request.url, request)
                        .then(res => {
                            // TODO: Directly handle the response stream.
                            let body = res._fastNodeBody();
                            const headers = this.convertHeaders(res.headers);
                            if (/^text\/html/.test(headers['content-type'])) {
                                body = this._addRegisterScripts(domain, body);
                            }

                            return {
                                status: res.status,
                                headers: headers,
                                body: body
                            };
                        });
                } else {
                    // Fall through to a plain request.

                    return fetch(request)
                    .then(res => {
                        return {
                            status: res.status,
                            headers: this.convertHeaders(res.headers),
                            body: res._fastNodeBody()
                        };
                    });

                }
            });
    }


    swRequest(req, domain) {
        const reqURL = 'https://' + domain
            + new Buffer(decodeURIComponent(req.params.path.replace(/^__sw_/, '')), 'base64').toString('utf8');
        return this._swcontainer.getRegistration(reqURL)
        .then(registration => {
            if (registration) {
                return {
                    status: 200,
                    headers: {
                        'content-type': 'application/javascript',
                        'Access-Control-Allow-Origin': '*',
                    },
                    body: registration.x_getWorkerSource()
                };
            } else {
                return {
                    status: 404
                };
            }
        });
    }

}

module.exports = function(options) {
    const swproxy = new ServiceWorkerProxy(options);
    return {
        spec: {
            paths: {
                '/{+path}': {
                    all: {
                        operationId: 'proxyRequest',
                        consumes: [ '*/*' ],
                        parameters: [
                        {
                            name: 'path',
                            in: 'path',
                            type: 'string',
                            description: 'The request path',
                        }],
                    },
                },
            },
        },
        operations: {
            proxyRequest: swproxy.proxyRequest.bind(swproxy),
        },
    };
};
