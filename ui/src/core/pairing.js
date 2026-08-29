const STORAGE_KEY = 'tizen-homebrew.pin';
const DIGITS = 6;

const pattern = new RegExp(`^\\d{${DIGITS}}$`);

// The phone keeps the last code that worked and offers it on connect. Storage is per origin, so
// per television — and it is thrown away the moment the service refuses it, since a rejected code
// has been replaced and offering it again only spends the lockout allowance.
//
// Wrapped because a webview with storage disabled throws on access rather than returning null.
const remembered = () => {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return pattern.test(stored || '') ? stored : '';
    } catch (e) {
        return '';
    }
};

const remember = (pin) => {
    try {
        window.localStorage.setItem(STORAGE_KEY, pin);
    } catch (e) {
        // A convenience that cannot be saved is not worth failing over; the next reload simply asks.
    }
};

const forget = () => {
    try {
        window.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
        // Nothing to do: storage that cannot be written was never written.
    }
};

export { remembered, remember, forget, DIGITS };
