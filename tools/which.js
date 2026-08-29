'use strict';

const { accessSync, constants } = require('fs');
const { join, delimiter } = require('path');

const ROOT = join(__dirname, '..');

function isExecutable(path) {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch (e) {
        return false;
    }
}

// The repository's own node_modules/.bin before PATH: `npm run` already has it, running with node directly
// does not.
function which(binary) {
    const local = join(ROOT, 'node_modules', '.bin', binary);
    if (isExecutable(local)) return local;

    for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
        const candidate = join(dir, binary);
        if (isExecutable(candidate)) return candidate;
    }
    return null;
}

module.exports = { which };
