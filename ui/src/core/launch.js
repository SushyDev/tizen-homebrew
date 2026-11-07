const SERVICE_OPERATION = 'http://tizen.org/appcontrol/operation/service';

const capability = (key) => {
    try {
        return tizen.systeminfo.getCapability(key);
    } catch (e) {
        return null;
    }
};

const platformVersion = () => capability('http://tizen.org/feature/platform.version');
const modelName = () => capability('http://tizen.org/system/model_name');

const major = (version) => parseInt(version, 10) || 0;

// Tizen's errors carry the useful part in their name, such as NotFoundError or SecurityError.
const describe = (error) => {
    if (!error) return 'no reason given';

    const message = error.message || String(error);
    return error.name && error.name !== 'Error' && message.indexOf(error.name) === -1 ? `${error.name}: ${message}` : message;
};

let loaded = null;

// A module script, because the import has to reach the web runtime rather than the bundler.
const wrtService = () => {
    if (loaded) return loaded;

    loaded = new Promise((resolve) => {
        const done = () => resolve(window.__homebrewWrtService || null);

        window.addEventListener('homebrew-wrt-service', done, { once: true });
        setTimeout(done, 3000);

        const script = document.createElement('script');
        script.type = 'module';
        script.text = "import { Service } from 'wrt:service'; window.__homebrewWrtService = Service; " +
            "window.dispatchEvent(new Event('homebrew-wrt-service'));";
        document.body.appendChild(script);
    });

    return loaded;
};

const viaAppControl = (id) => new Promise((resolve, reject) => {
    try {
        tizen.application.launchAppControl(new tizen.ApplicationControl(SERVICE_OPERATION), id, resolve, reject);
    } catch (error) {
        reject(error);
    }
});

// Tizen 9 and later answer a launchAppControl for a service with success and never start it.
const startService = (id, version) => {
    if (major(version) < 9) return viaAppControl(id).then(() => 'launchAppControl');

    return wrtService().then((Service) => {
        if (!Service) return viaAppControl(id).then(() => 'launchAppControl');

        return Promise.resolve()
            .then(() => new Service(id).start())
            .then(() => 'wrt:service', (error) => viaAppControl(id).then(() => 'launchAppControl', () => {
                throw error;
            }));
    });
};

export { platformVersion, modelName, major, describe, startService };
