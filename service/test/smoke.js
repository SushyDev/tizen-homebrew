'use strict';

// Does the built bundle load and answer, on whatever Node is running this file?
//
// This is the test that would have caught it. `require('fs/promises')` is a
// Node 14 specifier; the televisions run Node 12 and older. It parsed, it
// passed the syntax floor, it passed all 154 checks on a laptop running Node
// 24 — and on the set the service died on its first require, the port never
// opened, and there was no log to say why because nothing had started that
// could write one. Loading the bundle under the oldest Node we support is a
// one-line answer to a question that otherwise costs an evening.
//
// ES5 on purpose: var, function, string concatenation, no arrows and no
// template literals. This file has to run on the oldest runtime in the matrix,
// which means it cannot use anything the bundle is not allowed to use either.
// mkdtempSync is avoided for the same reason — it arrived in Node 5.10.

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

// Kept away from any real Tizen Homebrew state on this machine.
var configDir = path.join(os.tmpdir(), 'homebrew-smoke-' + process.pid + '-' + Date.now());
fs.mkdirSync(configDir);

process.env.HOMEBREW_PORT = String(PORT);
process.env.HOMEBREW_CONFIG_DIR = configDir;

// The catalogue cache is derived from the home directory rather than from
// HOMEBREW_CONFIG_DIR, so this is pointed somewhere disposable too. A test
// that leaves files in somebody's home directory gets run less often.
process.env.HOME = configDir;

var entry = path.join(__dirname, '..', 'dist', 'index.js');

if (!fs.existsSync(entry)) fail('no bundle at ' + entry + ' — run `npm run build` first.');

// The load itself is the point. A module the runtime cannot resolve throws
// here, which is exactly what happened on the television.
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

// Off-TV the bundle starts itself on require, but binding is asynchronous.
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
