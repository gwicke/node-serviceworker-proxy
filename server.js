#!/usr/bin/env node

"use strict";

// Improve performance
global.Promise = require('bluebird');

// B/C wrapper to make the old init script work with service-runner.
var ServiceRunner = require('service-runner');

// Improve performance
global.Promise = require('bluebird');

new ServiceRunner().start();
