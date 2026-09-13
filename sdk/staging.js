'use strict';

// A directory read as package contents. Kept out of packaging.js so that nothing which runs on a
// television ever reaches for the filesystem to sign something.

const { readdirSync, readFileSync, statSync } = require('fs');
const { join, relative } = require('path');

const { uriOf, pathOf, MANIFESTS } = require('./packaging.js');

const refuse = (message) => Object.assign(new Error(message), { code: 'packagingFailed', isFriendly: true });

// Sorted, so the same directory always produces the same archive.
const walk = (root, from) => readdirSync(from, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort()
    .reduce((found, name) => {
        const path = join(from, name);

        return statSync(path).isDirectory()
            ? [...found, ...walk(root, path)]
            : [...found, { uri: uriOf(relative(root, path)), data: readFileSync(path) }];
    }, []);

const contentsOf = (root) => {
    const files = walk(root, root);

    if (!files.some((file) => MANIFESTS.indexOf(pathOf(file.uri)) !== -1)) {
        throw refuse(`${root} has no config.xml or tizen-manifest.xml, so it is not a Tizen package.`);
    }

    return files;
};

module.exports = { contentsOf };
