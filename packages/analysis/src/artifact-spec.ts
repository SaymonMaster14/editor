/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec types shared by the disk and memory artifact stores. Portable:
// no node imports, so renderer code can name specs without dragging in
// the filesystem backend.

export type ArtifactSpec = {
  kind: string;
  sourceHash: string;
  parametersHash: string;
  engine: string;
  engineVersion: string;
  duration?: number;
  fps?: number;
  metadata?: Record<string, unknown>;
};

export type FailureRecord = { error: string; at: string; spec: ArtifactSpec };
