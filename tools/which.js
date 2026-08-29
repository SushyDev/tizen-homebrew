'use strict';

const { execFileSync } = require('child_process');
const { accessSync, statSync, constants } = require('fs');
const { join, delimiter, extname } = require('path');

const ROOT = join(__dirname, '..');
const WINDOWS = process.platform === 'win32';

// CreateProcess appends .exe to a bare name and nothing else, so `npm` and the node_modules/.bin
// shims are only found under one of the suffixes PATHEXT lists.
const EXTENSIONS = WINDOWS
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

// Windows has no executable bit, and X_OK there passes for any file that exists — including the
// extensionless bash shim npm writes next to the .cmd one, which CreateProcess cannot launch.
function isExecutable(path) {
    try {
        if (WINDOWS) return statSync(path).isFile();
        accessSync(path, constants.X_OK);
        return true;
    } catch (e) {
        return false;
    }
}

function candidates(directory, binary) {
    const already = EXTENSIONS.some((extension) => extname(binary).toLowerCase() === extension.toLowerCase());
    if (already) return [join(directory, binary)];
    return EXTENSIONS.map((extension) => join(directory, binary + extension));
}

// The repository's own node_modules/.bin before PATH: `npm run` already has it, running with node
// directly does not.
function which(binary) {
    const directories = [join(ROOT, 'node_modules', '.bin')]
        .concat((process.env.PATH || '').split(delimiter).filter(Boolean));

    for (const directory of directories) {
        for (const candidate of candidates(directory, binary)) {
            if (isExecutable(candidate)) return candidate;
        }
    }
    return null;
}

// Node's own `shell: true` joins the arguments without quoting them, which loses any certificate
// path that has a space in it.
function commandLine(file, args) {
    const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
    return `"${[file].concat(args).map(quote).join(' ')}"`;
}

// Callers that resolve a binary themselves want the "run npm install" answer, not an ENOENT.
function need(binary) {
    const found = which(binary);
    if (found) return found;

    const error = new Error(`${binary} was not found. Run: npm install`);
    error.isFriendly = true;
    throw error;
}

// A .cmd shim is a batch file, not a binary, so cmd.exe has to be the thing that runs it.
function runSync(file, args, options) {
    if (WINDOWS && /\.(cmd|bat)$/i.test(file)) {
        return execFileSync(
            process.env.ComSpec || 'cmd.exe',
            ['/d', '/s', '/c', commandLine(file, args)],
            Object.assign({}, options, { windowsVerbatimArguments: true })
        );
    }
    return execFileSync(file, args, options);
}

// `npm run` exports the path to npm's own entry script; running that with this node skips the
// shims altogether.
function npm(args, options) {
    const entry = process.env.npm_execpath;
    if (entry && extname(entry) === '.js') return runSync(process.execPath, [entry].concat(args), options);

    return runSync(need('npm'), args, options);
}

module.exports = { which, need, runSync, npm };
