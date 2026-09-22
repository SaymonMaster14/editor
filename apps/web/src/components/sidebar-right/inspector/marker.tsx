/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { For, Show } from 'solid-js';
import { ControlRow } from '@/components/ui/control-group';
import { Icon } from '@/components/ui/icon';
import { PanelSection } from '@/components/ui/panel-section';
import { ControlledTextField } from '@/components/ui/text-field';
import {
  Select,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectPortal,
} from '@/components/ui/select';
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import {
  Computed,
  FrameRate,
  Markers,
  secondsToFrames,
  setPlayhead,
  store,
} from "@diffusionstudio/runtime";
import { useActiveScene, useDerived } from "@/engine/hooks";
import {
  DEFAULT_MARKER_COLOR,
  MARKER_COLORS,
  addMarker,
  markerColorHex,
  moveMarker,
  removeMarker,
} from "@/engine/markers";

/**
 * The scene's markers: a list of its flags, and an editor for the one the
 * playhead stands on. The list reads the `Markers` trait live; every button
 * and field goes through the canonical marker ops, so the panel, the ruler
 * flags, the shortcuts and the agents all move the same flags.
 */
export function MarkerPanel() {
  const world = useWorld();
  const scene = useActiveScene();
  const markers = useTrait(scene, Markers);
  const fps = () => world.get(FrameRate)?.value ?? 30;

  const playhead = useDerived(() => {
    const target = scene();
    if (!target) return 0;
    return Math.round(store(world, Computed).localTime[target.id()] ?? 0);
  });

  const list = () => [...(markers()?.list ?? [])].sort((a, b) => a.at - b.at);
  const standing = () => list().find((marker) => marker.at === playhead());
  const palette = () => Object.keys(MARKER_COLORS);

  const commitTime = (value: string) => {
    const marker = standing();
    if (!marker) return;
    const seconds = parseMarkerTime(value, fps());
    if (seconds === null) return;
    moveMarker(world, { from: marker.at, to: secondsToFrames(seconds, fps()) });
  };

  const commitName = (value: string) => {
    const marker = standing();
    if (!marker) return;
    addMarker(world, { at: marker.at, name: value.trim() });
  };

  const commitColor = (value: string | null) => {
    const marker = standing();
    if (!marker || !value) return;
    addMarker(world, { at: marker.at, color: value });
  };

  const labelOf = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

  return (
    <PanelSection
      title={`Markers (${list().length})`}
      actions={
        <Tooltip>
          <TooltipTrigger
            as={Button}
            size="icon"
            variant="ghost"
            class="text-muted-foreground"
            onClick={() => addMarker(world)}
          >
            <Icon name="plus-add" />
          </TooltipTrigger>
          <TooltipContent>Add marker at playhead (M)</TooltipContent>
        </Tooltip>
      }
    >
      <Show
        when={standing()}
        fallback={<p class="text-xxs text-muted-foreground px-1 py-0.5">No marker at the playhead.</p>}
      >
        {(marker) => (
          <>
            <ControlRow label="Time" contentClass="grid grid-cols-2 gap-2">
              <ControlledTextField
                value={formatMarkerTime(marker().at, fps())}
                autoSelect
                onChange={(e) => commitTime(e.currentTarget.value)}
              />
              <Button
                size="small"
                variant="ghost"
                class="text-muted-foreground"
                onClick={() => removeMarker(world, { at: marker().at })}
              >
                Delete
              </Button>
            </ControlRow>
            <ControlRow label="Name">
              <ControlledTextField
                value={marker().name}
                placeholder="Marker"
                autoSelect
                onChange={(e) => commitName(e.currentTarget.value)}
              />
            </ControlRow>
            <ControlRow label="Color">
              <Select
                value={marker().color || DEFAULT_MARKER_COLOR}
                onChange={commitColor}
                options={palette()}
                itemComponent={(itemProps) => (
                  <SelectItem item={itemProps.item}>
                    <div class="flex items-center gap-2">
                      <div
                        class="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ "background-color": markerColorHex(itemProps.item.rawValue as string) }}
                      />
                      <span>{labelOf(itemProps.item.rawValue as string)}</span>
                    </div>
                  </SelectItem>
                )}
              >
                <SelectTrigger>
                  <SelectValue class="text-xxs">
                    {() => (
                      <div class="flex items-center gap-2">
                        <div
                          class="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ "background-color": markerColorHex(marker().color || DEFAULT_MARKER_COLOR) }}
                        />
                        <span>{labelOf(marker().color || DEFAULT_MARKER_COLOR)}</span>
                      </div>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectPortal>
                  <SelectContent />
                </SelectPortal>
              </Select>
            </ControlRow>
          </>
        )}
      </Show>

      <Show when={list().length > 0}>
        <div class="flex flex-col gap-0.5 pt-1">
          <For each={list()}>
            {(marker) => (
              <div
                class="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-muted/60 cursor-pointer"
                onClick={() => {
                  const target = scene();
                  if (target) setPlayhead(world, target, marker.at);
                }}
              >
                <div
                  class="w-1.5 h-1.5 shrink-0 rotate-45"
                  style={{ "background-color": markerColorHex(marker.color) }}
                />
                <span class="flex-1 truncate text-xxs">{marker.name || 'Marker'}</span>
                <span class="text-xxs text-muted-foreground tabular-nums">
                  {formatMarkerTime(marker.at, fps())}
                </span>
                <button
                  class="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground text-xxs px-1"
                  title="Delete marker"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeMarker(world, { at: marker.at });
                  }}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </PanelSection>
  );
}

/** A frame count as `m:ss:ff`, the way the ruler counts it. */
function formatMarkerTime(at: number, fps: number): string {
  const totalSeconds = Math.floor(at / fps);
  const frames = at - totalSeconds * fps;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

/**
 * Reads back what the time field spells: `m:ss:ff`, `m:ss`, or plain seconds.
 * Null when it spells nothing committable, in which case the field keeps its
 * old value and nothing is written.
 */
function parseMarkerTime(value: string, fps: number): number | null {
  const input = value.trim();
  if (!input) return null;

  if (!input.includes(':')) {
    const seconds = Number.parseFloat(input);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  const parts = input.split(':').map((part) => Number.parseInt(part.trim(), 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 60 + parts[1]! + parts[2]! / fps;
  return null;
}
