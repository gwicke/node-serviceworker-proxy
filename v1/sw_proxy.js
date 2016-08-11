'use strict';

const path = require('path');
const P = require('bluebird');

const ServiceWorkerContainer = require('node-serviceworker');
const fetch = require('node-fetch-polyfill');


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
        return fetch(path.join('https://' + domain, this._options.registration.paths[0]))
            // TODO: check return status / use higher level wrapper that maps
            // errors to throw().
            .then(res => res.json())
            .then(mapping => {
                // Remove all registrations for this domain
                this._swcontainer.unregisterDomain(domain);
                // scope -> url
                return P.each(Object.keys(mapping, scope => {
                    return this._swcontainer.register(mapping[scope],
                            { scope: scope, online: true });
                }));
            });
    }

    proxyRequest(hyper, req) {
        const rp = req.params;
        let setupPromise = P.resolve();
        if (!this._swcontainer.haveDomain(rp.domain)) {
            // First, install workers for this domain.
            setupPromise = this.refreshWorkersForDomain(rp.domain);
            // Refresh registrations every two minutes.
            setInterval(this.refreshWorkersForDomain.bind(this, rp.domain),
                    this._options.registration.refresh_interval_seconds * 1000);
        }

        return setupPromise
            .then(() => this._swcontainer.getRegistration(testURL))
            .then(registration => {
                if (registration) {
                    // Request is handled by a ServiceWorker.
                    return registration.fetch(rp.path);
                } else {
                    // Fall through to a plain request.
                    // TODO: Properly reconstruct request, including query,
                    // post body etc.
                    return fetch('https://' + rp.domain, {
                            method: req.method,
                            body: req.body,
                            headers: req.headers
                        });
                }
            });
    }
}

module.exports = function(options) {
    console.log('setup', options);
    const swproxy = new ServiceWorkerProxy(options);
    return {
        spec: {
            paths: {
                '/{path}': {
                    'all': {
                        operationId: 'proxyRequest',
                        consumes: '*/*',
                        parameters: [
                        {
                            name: 'path',
                            in: 'path',
                            type: 'string',
                            required: 'false',
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
