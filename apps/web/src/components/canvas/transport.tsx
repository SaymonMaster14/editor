/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show } from "solid-js";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import { Computed, FrameRate, Playback, togglePlayback } from "@diffusionstudio/runtime";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatFrames } from "@/components/timeline/time-format";
import { useActiveScene, useDerived } from "@/engine/hooks";
import { nextEditPoint, prevEditPoint } from "@/engine/seek-edit";
import { editPlayhead } from "@/engine/timing";

/**
 * The program monitor's transport: edit/frame stepping, play and loop
 * around a readable timecode. Every step goes through the same seeks the
 * shortcuts use — no second playback state, no shadow time.
 */
export function Transport() {
  const world = useWorld();
  const scene = useActiveScene();
  const frameRate = useTrait(world, FrameRate);
  const playback = useTrait(scene, Playback);
  const now = useDerived(() => scene()?.get(Computed)?.localTime ?? 0);

  const step = (delta: number) => {
    const entity = scene();
    if (!entity) return;
    editPlayhead(world, entity, now() + delta);
  };

  const toggleLooping = () => {
    const entity = scene();
    if (!entity) return;
    entity.set(Playback, { loop: !playback()?.loop });
  };

  return (
    <div class="absolute bottom-4 right-4 rounded-xl px-2 py-1.5 bg-background border border-border-strong flex gap-1 items-center z-10">
      <Tooltip>
        <TooltipTrigger
          as={Button}
          size="icon"
          variant="ghost"
          onClick={() => prevEditPoint(world)}
        >
          <Icon name="keyframe-go-to-previous" class="size-6" />
        </TooltipTrigger>
        <TooltipContent>Previous edit</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as={Button}
          size="icon"
          variant="ghost"
          onClick={() => step(-1)}
        >
          <Icon name="arrow-left" class="size-6" />
        </TooltipTrigger>
        <TooltipContent shortcut="A">Previous frame</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as={Button}
          size="icon"
          variant="ghost"
          onClick={() => scene() && togglePlayback(world, scene()!)}
        >
          <Show when={playback()?.playing} fallback={<Icon name="play" class="size-6" />}>
            <Icon name="pause" class="size-6" />
          </Show>
        </TooltipTrigger>
        <TooltipContent shortcut="Space">{playback()?.playing ? 'Pause' : 'Play'}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as={Button}
          size="icon"
          variant="ghost"
          onClick={() => step(1)}
        >
          <Icon name="arrow-right" class="size-6" />
        </TooltipTrigger>
        <TooltipContent shortcut="D">Next frame</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as={Button}
          size="icon"
          variant="ghost"
          onClick={() => nextEditPoint(world)}
        >
          <Icon name="keyframe-go-to-next" class="size-6" />
        </TooltipTrigger>
        <TooltipContent>Next edit</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as={Button}
          size="icon"
          variant="ghost"
          onClick={toggleLooping}
        >
          <Show when={playback()?.loop} fallback={<Icon name="controls-no-loop" />}>
            <Icon name="controls-loop" />
          </Show>
        </TooltipTrigger>
        <TooltipContent>{playback()?.loop ? 'Disable loop' : 'Enable loop'}</TooltipContent>
      </Tooltip>
      <span class="text-xs font-mono font-thin ml-1 select-none text-muted-foreground">
        {formatFrames(now(), frameRate()?.value ?? 30, 'standard')}
      </span>
    </div>
  );
}
