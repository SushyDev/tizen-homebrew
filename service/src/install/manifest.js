'use strict';

// Read without unzipping and without an XML parser: xml2js cost 99KB to extract two attributes.
const zip = require('./zip.js');

const sourceOf = (archive) => (Buffer.isBuffer(archive) ? zip.fromBuffer(archive) : archive);

const readFromZip = (archive, wanted) => zip.read(sourceOf(archive), wanted);

const identify = (archive) => {
    const attribute = (xml, tag, key) => {
        const element = new RegExp(`<${tag}\\b[^>]*>`).exec(xml);
        if (!element) return null;
        const found = new RegExp(`\\b${key}="([^"]*)"`).exec(element[0]);
        return found ? found[1] : null;
    };

    const widget = readFromZip(archive, 'config.xml');

    if (widget) {
        const xml = widget.toString('utf8');
        const packageId = attribute(xml, 'tizen:application', 'package');

        if (!packageId) throw badPackage('config.xml declares no package id.');

        const named = /<name\b[^>]*>([^<]*)<\/name>/.exec(xml);

        return {
            packageId,
            appId: attribute(xml, 'tizen:application', 'id'),
            name: named ? named[1].trim() : null,
            version: attribute(xml, 'widget', 'version'),
            iconPath: attribute(xml, 'icon', 'src'),
            isWgt: true
        };
    }

    const native = readFromZip(archive, 'tizen-manifest.xml');

    if (native) {
        const xml = native.toString('utf8');
        const packageId = attribute(xml, 'manifest', 'package');

        if (!packageId) throw badPackage('tizen-manifest.xml declares no package id.');

        const icon = /<icon\b[^>]*>([^<]*)<\/icon>/.exec(xml);

        return {
            packageId,
            appId: attribute(xml, 'ui-application', 'appid'),
            name: null,
            version: attribute(xml, 'manifest', 'version'),
            iconPath: icon ? icon[1].trim() : null,
            isWgt: false
        };
    }

    throw badPackage('No config.xml or tizen-manifest.xml — this is not a Tizen package.');
};

const badPackage = (message) => Object.assign(new Error(message), { code: 'badPackage' });

module.exports = { identify, readFromZip };
