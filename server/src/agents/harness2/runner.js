// agents/harness2/runner.js — thin re-export of harness-runner.js.
// Consumers: `require('./agents/harness2/runner')` or `require('./agents/harness2').startSweep(...)`.
'use strict';
module.exports = require('../../harness-runner');
