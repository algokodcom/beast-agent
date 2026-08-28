'use strict';

/* Ortak test kurulumu: tüm modüller izole BEAST_DATA altına yazsın. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-test-'));
process.env.BEAST_DATA = path.join(tmp, 'data');
