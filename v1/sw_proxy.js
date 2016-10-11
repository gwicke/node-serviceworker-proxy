'use strict';

const path = require('path');
const querystring = require('querystring');
const stream = require('stream');
const P = require('bluebird');
const FormData = require('form-data');
const crypto = require('crypto');
const resolve_url = require('url').resolve;
function make_url(domain, path) {
    if (!/^http:\/\//.test(domain)) {
        domain = 'https://' + domain;
    }
    return resolve_url(domain, path);
}

const ServiceWorkerContainer = require('node-serviceworker');
const fetch = require('node-fetch-polyfill');
const Request = fetch.Request;
const isNodeStream = require('is-stream');


class ServiceWorkerProxy {
    constructor(options) {
        this._options = options;
        // Compile default_domain_pattern, if set
        if (options.default_domain_pattern) {
            options.default_domain_pattern = new RegExp(options.default_domain_pattern);
        }
        this._swcontainer = new ServiceWorkerContainer();
    }

    /**
     * Install / refresh ServiceWorkers for a given domain
     *
     * Uses options.domains for the per-domain (or default) config.
     */
    refreshWorkersForDomain(domain, domainOptions) {
        // Remove all registrations for this domain
        this._swcontainer.x_clearDomain(domain);
        return this._swcontainer.register(domainOptions.scriptURL, domainOptions);
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
            const options = this._options;
            // Check if the domain is supported
            if (!options.domains[domain] && options.default_domain_restriction
                && !options.default_domain_restriction.test(domain)) {
                throw new Error(`Unsupported host: ${domain}`);
            }
            const domainOptions = Object.assign({},
                options.domain_defaults,
                options.domains[domain]);

            // Set up / normalize options.
            domainOptions.scriptURL = make_url(domain, domainOptions.scriptURL);
            domainOptions.scope = '/';
            domainOptions.origin = domain;

            // All is good. Install workers for this domain.
            setupPromise = this.refreshWorkersForDomain(domain, domainOptions);
            // Refresh registrations periodically in the background.
            setInterval(this.refreshWorkersForDomain.bind(this, domain, domainOptions),
                    domainOptions.sw_default_cache_control['s-maxage'] * 1000);
        }

        if (/^__?sw.js$/.test(rp.path)) {
            // Request for a ServiceWorker
            return setupPromise.then(() => this.swRequest(req, domain));
        }

        // ServiceWorker expects absolute URLs, so resolve the URL.
        req.uri = make_url(domain, req.params.path);
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
                                // Add a SW registration header. See
                                // https://github.com/w3c/ServiceWorker/issues/685 for spec discussion.
                                // Header-based registration is currently only
                                // supported in Chrome, but that's mostly a
                                // good thing as Firefox's ServiceWorker
                                // support ist still fairly immature. For
                                // example, it is lacking ReadableStream
                                // support.
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
                            + this._options.domain_defaults.sw_default_cache_control['max-age'],
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
