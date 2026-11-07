'use strict';

const { readFileSync, writeFileSync, unlinkSync, mkdirSync } = require('fs');
const { homedir } = require('os');
const { join, dirname } = require('path');

const PATH = process.env.HOMEBREW_LASTRUN_PATH || join(homedir(), 'share', 'homebrewLastRun.json');

const firstLines = (error) => String((error && error.stack) || error).split('\n').slice(0, 6).join('\n');

// Written synchronously, because the process may be on its way out.
const record = (what, error, build) => {
    try {
        mkdirSync(dirname(PATH), { recursive: true });
        writeFileSync(PATH, JSON.stringify({
            at: new Date().toISOString(),
            what,
            build: build || null,
            message: String((error && error.message) || error),
            stack: firstLines(error)
        }));
    } catch (e) {}
};

const recall = () => {
    try {
        const found = JSON.parse(readFileSync(PATH, 'utf8'));
        unlinkSync(PATH);
        return found;
    } catch (e) {
        return null;
    }
};

const watch = (build) => {
    if (process.__homebrewLastRun) return;
    process.__homebrewLastRun = true;

    process.on('uncaughtException', (error) => record('an uncaught exception', error, build));
    process.on('unhandledRejection', (reason) => record('an unhandled rejection', reason, build));
};

module.exports = { record, recall, watch, PATH };
