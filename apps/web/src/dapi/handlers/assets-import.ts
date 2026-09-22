/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLibrary } from "@diffusionstudio/runtime";
import { importInternetAsset } from "@/engine/internet-import";

import type { ToolHandler } from "../handler";

/**
 * The agent's internet import: a thin shell over the canonical
 * `importInternetAsset`, which the human Search tab shares — same guards,
 * same provenance, same library bytes.
 */
export const assetsImport: ToolHandler<"assets_import"> = async (
  { candidate, alternate, url, query, name, folder },
  ctx,
) => {
  const { world } = ctx.requireSession();
  const library = getLibrary(world);
  const { asset, name: storedName, size, provenance } = await importInternetAsset(library, {
    ...(candidate ? { candidate } : {}),
    ...(alternate ? { alternate } : {}),
    ...(url ? { url } : {}),
    ...(query ? { query } : {}),
    ...(name ? { name } : {}),
    ...(folder ? { folder } : {}),
  });

  return {
    id: asset.id,
    path: asset.path,
    name: storedName,
    type: asset.type,
    mimeType: asset.mimeType,
    size,
    ...("width" in asset && { width: asset.width, height: asset.height }),
    ...("duration" in asset && { duration: asset.duration }),
    provenance,
  };
};
