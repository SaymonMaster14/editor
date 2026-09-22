/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "./ipc";

/** A download through the main process: validated bytes plus where they landed. */
export interface MainDownload {
  blob: Blob;
  finalUrl: string;
}

/**
 * Downloads a URL through the main process, where the guarded downloader
 * runs with DNS checks and no CORS. Rejects with the guard's reason
 * (refused host, bad content type, too large, HTTP error).
 */
export async function downloadViaMain(url: string): Promise<MainDownload> {
  const { data, finalUrl, contentType } = await mainBridge.call(MAIN_CHANNELS.ASSETS_DOWNLOAD, { url });
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data as ArrayLike<number>);
  return { blob: new Blob([bytes as BlobPart], { type: contentType }), finalUrl };
}

/**
 * The asset library's remote fetcher: downloads through main while running
 * in desktop, undefined elsewhere so the library falls back to its own
 * guarded in-renderer download.
 */
export function desktopFetcher(): ((url: string) => Promise<Blob>) | undefined {
  if (typeof window === "undefined" || !window.desktop) return undefined;
  return async (url: string) => (await downloadViaMain(url)).blob;
}
