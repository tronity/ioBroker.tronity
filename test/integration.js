const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { tests } = require('@iobroker/testing');
const pkg = require('../package.json');

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
// Workaround for controller setup on fresh CI test dirs: ensure test data/controller dirs exist
// so @iobroker/testing executes `setup first` and creates iobroker-data/iobroker.json.
const [appName, ...adapterParts] = pkg.name.split('.');
const adapterName = adapterParts.join('.');
const testDir = path.join(os.tmpdir(), `test-${appName}.${adapterName}`);
fs.mkdirSync(path.join(testDir, `${appName}-data`), { recursive: true });
fs.mkdirSync(path.join(testDir, 'node_modules', `${appName}.js-controller`), { recursive: true });

const controllerVersion = process.env.JS_CONTROLLER_VERSION || '6.0.11';
tests.integration(path.join(__dirname, '..'), { controllerVersion });
