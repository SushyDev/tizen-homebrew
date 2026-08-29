'use strict';

var http = require('http');
var os = require('os');
var fs = require('fs');
var path = require('path');

var PORT = Number(process.env.HOMEBREW_PORT) || 8390;
var DEADLINE = 20000;

function fail(message) {
    process.stderr.write('FAIL  ' + message + '\n');
    process.exit(1);
}

function pass(message) {
    process.stdout.write('PASS  ' + message + '\n');
}

var configDir = path.join(os.tmpdir(), 'homebrew-smoke-' + process.pid + '-' + Date.now());
fs.mkdirSync(configDir);

process.env.HOMEBREW_PORT = String(PORT);
process.env.HOMEBREW_CONFIG_DIR = configDir;

process.env.HOME = configDir;

var entry = path.join(__dirname, '..', 'dist', 'index.js');

if (!fs.existsSync(entry)) fail('no bundle at ' + entry + ' — run `npm run build` first.');

try {
    require(entry);
} catch (e) {
    fail('the bundle would not load on ' + process.version + ': ' + ((e && e.message) || e));
}

pass('the bundle loads on ' + process.version);

function get(pathname, done) {
    var request = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, function (response) {
        var body = '';
        response.on('data', function (chunk) { body += chunk; });
        response.on('end', function () { done(null, response.statusCode, body); });
    });

    request.on('error', function (error) { done(error); });
    request.setTimeout(4000, function () { request.abort(); });
}

var began = Date.now();

(function waitForPort() {
    get('/health', function (error, status, body) {
        if (error || status !== 200) {
            if (Date.now() - began > DEADLINE) {
                fail('the service never answered on port ' + PORT + ' within ' + (DEADLINE / 1000) + 's' +
                    (error ? ' (' + error.message + ')' : ' (status ' + status + ')'));
            }

            return setTimeout(waitForPort, 250);
        }

        var health;
        try {
            health = JSON.parse(body);
        } catch (e) {
            return fail('/health did not answer JSON: ' + body.slice(0, 120));
        }

        if (health.ok !== true) return fail('/health answered ' + body.slice(0, 120));

        pass('/health answers, bound on port ' + PORT + ' after ' + (Date.now() - began) + 'ms');

        get('/version', function (versionError, versionStatus, versionBody) {
            if (versionError || versionStatus !== 200) {
                return fail('/version did not answer' + (versionError ? ': ' + versionError.message : ''));
            }

            var reported;
            try {
                reported = JSON.parse(versionBody);
            } catch (e) {
                return fail('/version did not answer JSON: ' + versionBody.slice(0, 120));
            }

            if (!reported.build) return fail('/version answered without a build stamp');

            pass('/version reports ' + reported.build + ' on ' + reported.node);

            process.stdout.write('\nSmoke passed on ' + process.version + '.\n');
            process.exit(0);
        });
    });
})();
