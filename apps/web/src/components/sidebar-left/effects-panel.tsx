/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createMemo, createSignal } from "solid-js";
import { Effect as EffectElement } from "@diffusionstudio/reconciler";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEditor, useSelection } from "@/engine/hooks";
import { EFFECT_OPTIONS } from "@/components/sidebar-right/inspector/effect-types";

import type { EffectOption } from "@/components/sidebar-right/inspector/effect-types";

/**
 * The effects browser: every layer effect the runtime really renders,
 * searchable, applied to the selected clip with one click. Applying authors
 * the same `<effect>` child the inspector's plus authors, so the browser,
 * the inspector and the agent meet on the one element.
 */
export function EffectsPanel() {
  const editor = useEditor();
  const { first } = useSelection();
  const [query, setQuery] = createSignal("");

  const options = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return EFFECT_OPTIONS;
    return EFFECT_OPTIONS.filter((option) => option.label.toLowerCase().includes(q));
  });

  const apply = (option: EffectOption) => {
    const target = first();
    if (!target) return;
    editor.insertElement(target, () => (
      <EffectElement type={option.name} value={option.value} />
    ));
  };

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="px-3 py-2">
        <input
          type="text"
          placeholder="Search effects"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.stopPropagation()}
          class="w-full text-xs bg-input border border-border rounded-md outline-none px-2 py-1.5 text-foreground placeholder:text-muted-foreground focus:border-primary"
        />
      </div>
      <div class="flex-1 overflow-y-auto px-1.5 pb-3">
        <For each={options()}>
          {(option) => (
            <div class="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent group">
              <Icon name="fx" class="size-6 text-muted-foreground" />
              <span class="flex-1 min-w-0">
                <span class="block text-xs text-foreground truncate">{option.label}</span>
              </span>
              <Tooltip placement="left">
                <TooltipTrigger
                  as={Button}
                  size="icon"
                  variant="ghost"
                  class="text-muted-foreground invisible group-hover:visible"
                  disabled={!first()}
                  onClick={() => apply(option)}
                >
                  <Icon name="plus-add" />
                </TooltipTrigger>
                <TooltipContent>{first() ? `Apply to selection` : `Select a clip first`}</TooltipContent>
              </Tooltip>
            </div>
          )}
        </For>
        <Show when={options().length === 0}>
          <p class="text-xs text-muted-foreground text-center py-8">No effects match.</p>
        </Show>
      </div>
    </div>
  );
}
