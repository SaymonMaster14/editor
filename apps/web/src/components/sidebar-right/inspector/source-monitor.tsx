/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Match, Show, Switch, createEffect, createMemo, createSignal } from "solid-js";
import { toast } from "somoto";
import { assetName } from "@diffusionstudio/assets";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDuration } from "@/utils/formatters";
import { useLibrary } from "@/engine/library";
import {
  DEFAULT_STILL_SECONDS,
  insertEdit,
  loadSourceMonitor,
  markIn,
  markOut,
  overwriteEdit,
  scrubSourceMonitor,
} from "@/engine/source-edit";
import { SourceMonitor } from "@/engine/traits";
import { AssetInfoPreview } from "./asset-info-preview";

import type { Asset } from "@diffusionstudio/assets";

/**
 * The source monitor: the selected asset's preview, the in/out range marked
 * on it, and the landings — insert (`,`), overwrite (`.`). Everything here
 * reads and writes the one `SourceMonitor` trait, so the range the human
 * marks with I/O is the range `source_edit` lands, and the other way round:
 * when an agent loads another asset, this panel says whose range it shows.
 */
export function SourceMonitorPanel(props: { asset: Asset }) {
  const world = useWorld();
  const library = useLibrary();
  const monitor = useTrait(world, SourceMonitor);
  const [previewTime, setPreviewTime] = createSignal(0);

  // Selecting an asset loads it, ranged end to end. Keyed on the id string,
  // not the asset object: a library refresh hands out new objects for the
  // same assets, and that must not wipe the marks back to the full run.
  const assetId = createMemo(() => props.asset.id);
  createEffect(() => {
    const id = assetId();
    if (id) loadSourceMonitor(world, id);
  });

  const run = createMemo(() => {
    const asset = props.asset;
    return "duration" in asset && typeof asset.duration === "number" ? asset.duration : DEFAULT_STILL_SECONDS;
  });

  const monitorAsset = createMemo(() => {
    const id = monitor()?.assetId;
    return id ? library()?.get(id) : undefined;
  });
  const mismatch = createMemo(() => {
    const id = monitor()?.assetId;
    return id != null && id !== props.asset.id;
  });

  // The preview's position becomes the monitor's — but only while the
  // monitor holds this asset. Scrubbing one preview must not drag another
  // asset's marks (an agent's, say) along with it.
  const handlePreviewPosition = (seconds: number) => {
    setPreviewTime(seconds);
    if (monitor()?.assetId === props.asset.id) scrubSourceMonitor(world, seconds);
  };

  const handleInsert = () => {
    if (!insertEdit(world)) {
      toast("Nothing to insert into", { description: "Open a project first." });
    }
  };

  const handleOverwrite = () => {
    if (!overwriteEdit(world)) {
      toast("Nothing to overwrite into", { description: "Open a project first." });
    }
  };

  return (
    <div class="flex flex-col gap-2">
      <AssetInfoPreview asset={props.asset} onPosition={handlePreviewPosition} />
      <div class="flex flex-col gap-2 rounded-md border border-border p-2">
        <div class="flex h-5 items-center justify-between text-xs text-muted-foreground">
          <span>Source</span>
          <span class="font-mono">
            {formatDuration(previewTime())} / {formatDuration(run())}
          </span>
        </div>
        <Show when={mismatch() && monitorAsset()}>
          {(asset) => (
            <div class="flex h-5 items-center justify-between gap-2 text-xs text-muted-foreground">
              <span class="min-w-0 flex-1 truncate">Monitor holds {assetName(asset())}</span>
              <Button variant="link" size="small" class="shrink-0" onClick={() => loadSourceMonitor(world, props.asset.id)}>
                Load selected
              </Button>
            </div>
          )}
        </Show>
        <div class="flex gap-2">
          <Tooltip>
            <TooltipTrigger
              as={Button}
              type="button"
              variant="secondary"
              class="flex-1"
              onClick={() => markIn(world)}
            >
              Mark In
            </TooltipTrigger>
            <TooltipContent shortcut="I">Mark the range in point at the preview</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              as={Button}
              type="button"
              variant="secondary"
              class="flex-1"
              onClick={() => markOut(world)}
            >
              Mark Out
            </TooltipTrigger>
            <TooltipContent shortcut="O">Mark the range out point at the preview</TooltipContent>
          </Tooltip>
        </div>
        <Switch>
          <Match when={monitor()?.assetId}>
            <div class="flex h-5 items-center justify-between font-mono text-xs text-muted-foreground">
              <span>in {formatDuration(monitor()!.in)}</span>
              <span>out {formatDuration(monitor()!.out)}</span>
            </div>
          </Match>
          <Match when={true}>
            <div class="flex h-5 items-center text-xs text-muted-foreground">
              <span>No source loaded</span>
            </div>
          </Match>
        </Switch>
        <div class="flex gap-2">
          <Tooltip>
            <TooltipTrigger
              as={Button}
              type="button"
              variant="default"
              class="flex-1"
              onClick={handleInsert}
            >
              Insert
            </TooltipTrigger>
            <TooltipContent shortcut=",">Land the range at the playhead, rippling later clips aside</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              as={Button}
              type="button"
              variant="secondary"
              class="flex-1"
              onClick={handleOverwrite}
            >
              Overwrite
            </TooltipTrigger>
            <TooltipContent shortcut=".">Land the range at the playhead where covered clips give way</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
