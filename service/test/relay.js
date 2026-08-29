'use strict';

const { Relay, isSelfDestructive, MAX_CONCURRENT } = require('../src/tv/relay.js');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
}

const relay = new Relay({ packageId: 'GJBBYNLkgP', log: () => {} });
check('relay is off unless explicitly enabled', relay.enabled === false, String(relay.enabled));

const SHOULD_REFUSE = [
    'buxton2ctl set-string system db/sdk/develop/ip 192.168.1.50',
    'buxton2ctl set-int32 system db/sdk/develop/mode 0',
    'pkgcmd -u -n GJBBYNLkgP',
    'vd_appuninstall GJBBYNLkgP'
];

const SHOULD_ALLOW = [
    'ls -la /home/owner/share',
    'cat /etc/info.ini',
    'pkgcmd -l',
    'pkgcmd -u -n xvvl3S1bvH',
    'buxton2ctl get system db/sdk/develop/ip',
    'df -h'
];

SHOULD_REFUSE.forEach((command) => {
    check(`refuses: ${command.slice(0, 48)}`,
        isSelfDestructive(command, 'GJBBYNLkgP') === true, 'was allowed');
});

SHOULD_ALLOW.forEach((command) => {
    check(`allows:  ${command.slice(0, 48)}`,
        isSelfDestructive(command, 'GJBBYNLkgP') === false, 'was refused');
});

relay.exec('a', 'ls /', {})
    .then(
        () => check('a disabled relay refuses commands', false, 'it ran anyway'),
        (err) => check('a disabled relay refuses commands', err.code === 'relayDisabled', err.code)
    )
    .then(() => {
        relay.setEnabled(true);
        check('setEnabled(true) turns it on', relay.enabled === true, String(relay.enabled));

        return relay.exec('b', 'buxton2ctl set-int32 system db/sdk/develop/mode 0', {}).then(
            () => check('refuses to disable developer mode', false, 'it ran anyway'),
            (err) => check('refuses to disable developer mode',
                err.code === 'badMessage' && /no way back in/.test(err.message), err.message)
        );
    })
    .then(() => {
        return relay.exec('c', '   ', {}).then(
            () => check('refuses a blank command', false, 'it ran anyway'),
            (err) => check('refuses a blank command', !!err, err.code)
        );
    })
    .then(() => {
        const stalled = new Promise(() => {});
        for (let i = 0; i < MAX_CONCURRENT; i++) relay.running.set(`slot${i}`, stalled);

        return relay.exec('overflow', 'ls /', {}).then(
            () => check('caps concurrent commands', false, 'it ran anyway'),
            (err) => check('caps concurrent commands', /Too many commands/.test(err.message), err.message)
        );
    })
    .then(() => {
        relay.running.clear();
        relay.setEnabled(false);
        check('setEnabled(false) turns it back off', relay.enabled === false, String(relay.enabled));

        const failed = results.filter((r) => !r).length;
        console.log(`\n${results.length - failed}/${results.length} checks passed.`);
        process.exit(failed ? 1 : 0);
    })
    .catch((err) => {
        console.error('Harness error:', err);
        process.exit(1);
    });
