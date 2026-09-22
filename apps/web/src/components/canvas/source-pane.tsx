/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show } from "solid-js";
import { Icon } from "@/components/ui/icon";
import { SourceMonitorPanel } from "@/components/sidebar-right/inspector/source-monitor";
import { useAssetSelection } from "@/engine/hooks";

/**
 * The source side of the dual viewer: the selected library asset's monitor
 * (preview, I/O marks, insert/overwrite into the timeline) beside the
 * program. Nothing here duplicates the monitor — it is the same panel,
 * the same trait, the same canonical source-edit ops.
 */
export function SourcePane() {
  const { asset } = useAssetSelection();

  return (
    <div class="size-full overflow-y-auto p-3">
      <Show
        when={asset()}
        fallback={
          <div class="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Icon name="video" class="size-8 text-muted-foreground" />
            <p class="text-xs text-muted-foreground">Select media in the Project panel to preview it here.</p>
          </div>
        }
      >
        {(selected) => <SourceMonitorPanel asset={selected()} />}
      </Show>
    </div>
  );
}
