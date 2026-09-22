/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { ControlRow } from "@/components/ui/control-group";
import { PanelSection } from "@/components/ui/panel-section";
import { ControlledTextField } from "@/components/ui/text-field";
import { formatProperty } from "@/components/timeline/layers/keyframe";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import {
  Keyframe as KeyframeTrait,
  KeyframeTrack,
  colorToHex,
  getParentEntity,
  parseColor,
} from "@diffusionstudio/runtime";
import { useEditor } from "@/engine/hooks";
import { deleteKeyframe, moveKeyframe, setKeyframeValue } from "@/engine/keyframes";

import type { Entity } from "koota";

type KeyframeSettingsProps = {
  selection: Entity[];
};

/**
 * The selected keyframes: when one diamond has the selection, its frame and
 * the value it holds, corrected as numbers; a color track's value reads and
 * writes as the CSS hex the file spells. Every write goes through the
 * canonical keyframe ops, the same ones the timeline drag, the Delete key
 * and the keyframe tool use. A multi-selection deletes as a block; its
 * easing stays with the interpolation panel below.
 */
export function KeyframeSettings(props: KeyframeSettingsProps) {
  const world = useWorld();
  const editor = useEditor();

  const first = () => props.selection[0]!;
  const keyframe = useTrait(first, KeyframeTrait);

  const trackPath = () => {
    const parent = getParentEntity(first());
    return parent?.has(KeyframeTrack) ? (parent.get(KeyframeTrack)?.property ?? "") : "";
  };
  const isColor = () => trackPath() === "color";

  const frame = () => Math.round(keyframe()?.time ?? 0);
  const valueText = () => {
    const value = keyframe()?.value ?? 0;
    return isColor() ? colorToHex(value) : String(value);
  };

  const commitFrame = (raw: string) => {
    const frame = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(frame)) return;
    moveKeyframe(world, editor, first(), frame);
  };

  const commitValue = (raw: string) => {
    const input = raw.trim();
    if (!input) return;
    if (isColor()) {
      // The file spells a color keyframe as CSS hex; the trait takes the
      // number, so only a parseable hex is committable.
      if (parseColor(input) === null) return;
      setKeyframeValue(editor, first(), input);
      return;
    }
    const value = Number.parseFloat(input);
    if (!Number.isFinite(value)) return;
    setKeyframeValue(editor, first(), value);
  };

  const deleteAll = () => {
    for (const entity of props.selection) deleteKeyframe(editor, entity);
  };

  return (
    <PanelSection
      title={props.selection.length > 1 ? `Keyframes (${props.selection.length})` : `Keyframe — ${formatProperty(trackPath())}`}
    >
      <Show
        when={props.selection.length === 1}
        fallback={<p class="text-xxs text-muted-foreground px-1 py-0.5">Several keyframes selected — easing below writes to all of them.</p>}
      >
        <ControlRow label="Frame" title="The clip-local frame this keyframe sits on">
          <ControlledTextField
            value={String(frame())}
            autoSelect
            onChange={(e) => commitFrame(e.currentTarget.value)}
            limitEvents
          />
        </ControlRow>
        <ControlRow label="Value">
          <ControlledTextField
            value={valueText()}
            autoSelect
            onChange={(e) => commitValue(e.currentTarget.value)}
            limitEvents
          />
        </ControlRow>
      </Show>
      <ControlRow label={props.selection.length === 1 ? "Keyframe" : "Selection"}>
        <Button
          size="small"
          variant="ghost"
          class="text-muted-foreground"
          onClick={deleteAll}
        >
          Delete
        </Button>
      </ControlRow>
    </PanelSection>
  );
}
