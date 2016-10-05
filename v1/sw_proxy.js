'use strict';

const path = require('path');
const querystring = require('querystring');
const stream = require('stream');
const P = require('bluebird');
const FormData = require('form-data');
const crypto = require('crypto');

const ServiceWorkerContainer = require('node-serviceworker');
const fetch = require('node-fetch-polyfill');
const Request = fetch.Request;
const isNodeStream = require('is-stream');


class ServiceWorkerProxy {
    constructor(options) {
        this._options = options;
        this._swcontainer = new ServiceWorkerContainer();
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
                        scriptURL: 'https://raw.githubusercontent.com/gwicke/streaming-serviceworker-playground/master/build/sw.js',
                        online: true
                    }];
                    // throw new Error(`Registration fetch for ${domain} failed`);
                }
                res.json();
            })
            .then(mappings => {
                // Remove all registrations for this domain
                this._swcontainer.x_clearDomain(domain);
                // scope -> url
                if (mappings.length > 1) {
                    throw new Error("Only a single ServiceWorker is allowed per domain.");
                }
                return P.each(mappings, mapping => {
                    if (mapping.scope !== '/') {
                        throw new Error("Only the root scope '/' is supported for ServiceWorkers!");
                    }
                    mapping.origin = domain;
                    return this._swcontainer.register(mapping.scriptURL, mapping);
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



        let setupPromise = P.resolve();
        if (!this._swcontainer._registrations.get(domain)) {
            // First, install workers for this domain.
            setupPromise = this.refreshWorkersForDomain(domain);
            // Refresh registrations every two minutes.
            setInterval(this.refreshWorkersForDomain.bind(this, domain),
                    this._options.registration.refresh_interval_seconds * 1000);
        }

        if (/^__?sw.js$/.test(rp.path)) {
            // Request for a ServiceWorker
            return setupPromise.then(() => this.swRequest(req, domain));
        }

        // ServiceWorker expects absolute URLs
        req.uri = 'https://' + domain + '/' + req.params.path;
        const request = this._makeRequest(req);
        return setupPromise
            .then(() => this._swcontainer.getRegistration(req.uri))
            .then(registration => {
                if (registration) {
                    // Request is handled by a ServiceWorker.
                    return registration.fetch(request.url, request)
                        .then(res => {
                            let body = res._fastNodeBody();
                            const headers = this.convertHeaders(res.headers);
                            // Only inject this into non-API / template
                            // requests.
                            if (/^text\/html/.test(headers['content-type']) && headers.age === undefined) {
                                // Add a SW registration header
                                headers.link = '</_sw.js>; rel=serviceworker; scope=/';
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
        const reqURL = 'https://' + domain + '/';
        return this._swcontainer.getRegistration(reqURL)
        .then(registration => {
            if (registration) {
                const src = registration.x_getWorkerSource();
                return {
                    status: 200,
                    headers: {
                        'content-type': 'application/javascript',
                        'access-control-allow-origin': '*',
                        'cache-control': 'max-age='
                            + this._options.registration.refresh_interval_seconds,
                        'etag': crypto.Hash('sha1').update(src).digest().toString('hex'),
                        'last-modified': new Date().toUTCString()
                    },
                    body: src
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
