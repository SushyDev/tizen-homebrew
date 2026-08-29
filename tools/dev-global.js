'use strict';

// Turns `npm run dev:service` into a developer build. The bundler sets this with `define`.
globalThis.__HOMEBREW_DEV__ = true;
