/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, type Accessor, type JSX } from 'solid-js';
import { assert } from '@/utils';
import { createStoredSignal } from '@/lib/store';
import { store } from '@/init';

/** The timeline's presentation: NLE shows track headers and pro controls, compact keeps Diffusion minimal. Pure presentation — same engine, same rows. */
export type TimelineView = 'compact' | 'nle';

/** The viewer arrangement: program alone, or the source monitor beside it. Default program-only. */
export type ViewerMode = 'program' | 'source-program';

type LayoutContextValue = {
  uiVisible: Accessor<boolean>;
  timelineMinimized: Accessor<boolean>;
  timelineHeight: Accessor<number>;
  setTimelineHeight(height: number): void;
  toggleUI(): void;
  toggleTimeline(): void;
  timelineView: Accessor<TimelineView>;
  toggleTimelineView(): void;
  viewerMode: Accessor<ViewerMode>;
  toggleViewerMode(): void;
};
const LayoutContext = createContext<LayoutContextValue>();

export const MIN_TIMELINE_HEIGHT = 120;
export const DEFAULT_TIMELINE_HEIGHT = 234;

export function LayoutProvider(props: { children: JSX.Element }) {
  const [uiVisible, setUiVisible] = createStoredSignal(
    store.define<boolean>('layout.uiVisible', true),
  );
  const [timelineHeight, setTimelineHeight] = createStoredSignal(
    store.define<number>('layout.timelineHeight', DEFAULT_TIMELINE_HEIGHT),
  );
  const [timelineMinimized, setTimelineMinimized] = createStoredSignal(
    store.define<boolean>('layout.timelineMinimized', false),
  );
  const [timelineView, setTimelineView] = createStoredSignal(
    store.define<TimelineView>('layout.timelineView', 'nle'),
  );
  const [viewerMode, setViewerMode] = createStoredSignal(
    store.define<ViewerMode>('layout.viewerMode', 'program'),
  );

  const toggleUI = () => setUiVisible(!uiVisible());
  const toggleTimeline = () => setTimelineMinimized(!timelineMinimized());
  const toggleTimelineView = () => setTimelineView(timelineView() === 'nle' ? 'compact' : 'nle');
  const toggleViewerMode = () => setViewerMode(viewerMode() === 'program' ? 'source-program' : 'program');

  return (
    <LayoutContext.Provider
      value={{
        uiVisible,
        timelineMinimized,
        timelineHeight,
        setTimelineHeight,
        toggleUI,
        toggleTimeline,
        timelineView,
        toggleTimelineView,
        viewerMode,
        toggleViewerMode,
      }}>
      {props.children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  const ctx = useContext(LayoutContext);
  assert(ctx, 'useLayout must be used within LayoutProvider');
  return ctx;
}
