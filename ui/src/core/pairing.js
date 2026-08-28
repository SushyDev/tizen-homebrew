// Remembering the PIN.
//
// The pairing code is a fact about the running service, not about the phone:
// it is minted at start-up and never written down, so it is valid for exactly
// as long as the channel keeps running. Reloading the page is not a reason to
// be asked for it again — a tab gets reloaded a dozen times while an install
// is being watched, and reading six digits off a television across the room
// every time is the whole cost this removes.
//
// So the phone keeps the last code that worked and offers it when it
// connects. Storage is per origin, which here is per television, so two TVs
// never see each other's code. And it is thrown away the moment the service
// refuses it: a rejected code is one that has been replaced, and offering it
// again would only spend the lockout allowance — see service/src/auth/pin.js.
//
// It is a LAN pairing code held on the person's own phone, which is where it
// already was — typed into the field, then sent as a header on every upload.
// Keeping it in the same browser it was typed into adds no reader that did
// not have it.

const STORAGE_KEY = 'tizen-homebrew.pin';
const DIGITS = 6;

const pattern = new RegExp(`^\\d{${DIGITS}}$`);

/**
 * The last PIN that paired, or an empty string.
 *
 * Wrapped because a webview with storage disabled throws on access rather
 * than returning null, and being asked to pair again is a far better outcome
 * than a page that does not start. The shape is checked on the way out: what
 * comes back is whatever is under that key, not necessarily what was put
 * there.
 */
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
        // A convenience that cannot be saved is not worth failing over; the
        // next reload simply asks.
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
