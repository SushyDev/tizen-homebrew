'use strict';

// Turns `npm run dev:service` into a developer build. The bundler sets this with
// `define`; running the sources directly, there is no bundler.

globalThis.__HOMEBREW_DEV__ = true;
