/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";

const FontStyle = z.enum(["normal", "italic"]);

export const FontFamily = z.object({
  family: z.string(),
  variants: z.array(
    z.object({
      weight: z.string().describe("CSS weight, 100-900"),
      style: FontStyle,
      source: z.string().describe("CSS `local()` source list"),
    }),
  ),
});

/** Families returned when no limit is given. */
export const FONT_LIMIT = 50;

export const fonts = defineTool({
  name: "fonts",
  title: "Local fonts",
  description:
    "List the local fonts available on this machine (macOS and Windows). These family names are valid `fontFamily` values on <text>; each family lists its variants. A machine has hundreds of families, so filter by family name when looking for one; total tells whether the limit cut the list.",
  input: z.object({
    family: z.string().optional().describe("filter to families whose name contains this (case-insensitive)"),
    weights: z.array(z.string()).optional().describe('filter to variants with the given CSS weights, e.g. ["400", "700"]'),
    style: FontStyle.optional().describe("filter to variants with the given style, normal or italic"),
    limit: z.int().min(1).optional().describe(`return at most this many families (default: ${FONT_LIMIT})`),
  }),
  output: z.object({
    families: z.array(FontFamily),
    total: z.int().describe("families matching the filters before the limit; more than were returned means the list was cut"),
  }),
  environment: "main",
});
