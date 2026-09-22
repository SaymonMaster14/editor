/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The runtime-agnostic side of the package: internet acquisition (provider
// search, the hardened downloader, provenance) with no DOM, no solid-js,
// no library. The desktop main process and any other Node runtime import
// `@diffusionstudio/assets/internet`; the barrel (`index.ts`) additionally
// carries the library, its cache, and browser helpers, which need a DOM.

export * from './download';
export * from './provenance';
export * from './providers';
