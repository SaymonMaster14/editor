/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


import type { z } from "zod";

export { defineTool } from "./tool";
export type { Tool, GenericTool, Environment } from "./tool";

export { catalog, tools, toolByName, isToolName } from "./catalog";
export type { AnyTool, ToolName, ToolByName, ToolInput, ToolArgs, ToolOutput, ToolResult } from "./catalog";

export { Time, NonNegativeTime, TIME_FORMS } from "./time";
export type { TimeInput } from "./time";

export { DapiError, isDapiError } from "./errors";
export type { DapiErrorCode } from "./errors";

export { MAX_FRAMES_PER_SHEET, Bytes } from "./schemas";

export { LoudnessMeasurement, BeatGridMeasurement, finiteDb } from "./audio";

export { SEGMENT_ENGINE, SEGMENT_ENGINE_VERSION, SegmentDetection, SegmentDetectionRef } from "./segment";
export type { SegmentWorkerDetection, SegmentWorkerResult } from "./segment";

export { DEPTH_ENGINE, DEPTH_ENGINE_VERSION } from "./depth";
export type { DepthWorkerResult } from "./depth";

export { FLOW_ENGINE_DIS, FLOW_ENGINE_RAFT, FLOW_ENGINE_VERSION_DIS, FLOW_ENGINE_VERSION_RAFT } from "./flow";
export type { FlowWorkerResult } from "./flow";

export { INLINE_MAX_IMAGES, INLINE_MAX_BYTES, qaDelivery, selectSweepPositions, framePixelStats, detectLayoutIssues } from "./qa";

export { MCP_HOST, MCP_PORT, MCP_PATH, MCP_URL } from "./mcp";
export { JSON_SCHEMA_DIALECT, toolJsonSchemas } from "./json-schema";
export type { ToolJsonSchemas } from "./json-schema";
export { DAPI_WIRE } from "./ipc";
export type { DapiCall, DapiCancel, DapiReply } from "./ipc";
export { FRAME_CAP } from "./tools/media-grab";
export { SEGMENT_MAX_WIDTH } from "./tools/media-segment";
export { DEPTH_MAX_WIDTH } from "./tools/media-depth";
export { FLOW_MAX_WIDTH } from "./tools/media-flow";
export { ISSUE_LOG_TAIL } from "./tools/report";
export { LOG_TAIL, LOG_MESSAGE_MAX } from "./tools/logs";
export { FONT_LIMIT } from "./tools/fonts";

// Named request and result types, for handlers that spell out their
// signature. Each is the parsed (output) side of the tool's schema.
import type { ImageRef as ImageRefSchema, LogEntry as LogEntrySchema, LogLevel as LogLevelSchema, TimecodedImage as TimecodedImageSchema } from "./schemas";
import type { GenerationRow as GenerationRowType } from "./tools/context";
import type { CheckIssue as CheckIssueSchema, CheckIssueCode as CheckIssueCodeSchema } from "./tools/check";
import type {
  QaSweepMode as QaSweepModeSchema,
  QaFinding as QaFindingSchema,
  QaFindingCode as QaFindingCodeSchema,
  QaFrameAnalysis as QaFrameAnalysisSchema,
  QaReceiptImage as QaReceiptImageSchema,
  QaReceipt as QaReceiptSchema,
  QaReceiptRef as QaReceiptRefSchema,
  QaLandmark,
  QaPosition,
  QaPixelStats,
  QaLayoutNode,
  QaDelivery,
} from "./qa";
import type { ExportFormat as ExportFormatSchema, ExportSettings as ExportSettingsSchema } from "./tools/export";
import type { ModelInfo as ModelInfoSchema } from "./tools/models";
import type { VoiceInfo as VoiceInfoSchema } from "./tools/voices";
import type { FrameQuality as FrameQualitySchema } from "./tools/media-grab";
import type { TranscriptSegment as TranscriptSegmentSchema, TranscriptWord as TranscriptWordSchema } from "./tools/media-transcribe";
import type { FontFamily as FontFamilySchema } from "./tools/fonts";
import type { AssetAlternate as AssetAlternateSchema, AssetCandidate as AssetCandidateSchema, AssetDownload as AssetDownloadSchema, AssetImageRef as AssetImageRefSchema, AssetKind as AssetKindSchema, AssetLicense as AssetLicenseSchema, AssetOrientation as AssetOrientationSchema, AssetProvenance as AssetProvenanceSchema, AssetProviderOutcome as AssetProviderOutcomeSchema } from "./assets";
import type { LoudnessMeasurement as LoudnessMeasurementSchema } from "./audio";
import type { ToolArgs, ToolOutput, ToolResult } from "./catalog";

export type LogLevel = z.output<typeof LogLevelSchema>;
export type LogEntry = z.output<typeof LogEntrySchema>;
export type TimecodedImage = z.output<typeof TimecodedImageSchema>;
export type ImageRef = z.output<typeof ImageRefSchema>;
export type GenerationRow = GenerationRowType;
export type CheckIssueCode = z.output<typeof CheckIssueCodeSchema>;
export type CheckIssue = z.output<typeof CheckIssueSchema>;
export type { QaLandmark, QaPosition, QaPixelStats, QaLayoutNode, QaDelivery };
export type QaSweepMode = z.output<typeof QaSweepModeSchema>;
export type QaFindingCode = z.output<typeof QaFindingCodeSchema>;
export type QaFinding = z.output<typeof QaFindingSchema>;
export type QaFrameAnalysis = z.output<typeof QaFrameAnalysisSchema>;
export type QaReceiptImage = z.output<typeof QaReceiptImageSchema>;
export type QaReceipt = z.output<typeof QaReceiptSchema>;
export type QaReceiptRef = z.output<typeof QaReceiptRefSchema>;
export type ExportFormat = z.output<typeof ExportFormatSchema>;
export type ExportSettings = z.output<typeof ExportSettingsSchema>;
export type ModelInfo = z.output<typeof ModelInfoSchema>;
export type VoiceInfo = z.output<typeof VoiceInfoSchema>;
export type FrameQuality = z.output<typeof FrameQualitySchema>;
export type TranscriptWord = z.output<typeof TranscriptWordSchema>;
export type TranscriptSegment = z.output<typeof TranscriptSegmentSchema>;
export type FontFamily = z.output<typeof FontFamilySchema>;
export type AssetKind = z.output<typeof AssetKindSchema>;
export type AssetOrientation = z.output<typeof AssetOrientationSchema>;
export type AssetLicense = z.output<typeof AssetLicenseSchema>;
export type AssetImageRef = z.output<typeof AssetImageRefSchema>;
export type AssetDownload = z.output<typeof AssetDownloadSchema>;
export type AssetAlternate = z.output<typeof AssetAlternateSchema>;
export type AssetCandidate = z.output<typeof AssetCandidateSchema>;
export type AssetProviderOutcome = z.output<typeof AssetProviderOutcomeSchema>;
export type AssetProvenance = z.output<typeof AssetProvenanceSchema>;
export type LoudnessMeasurement = z.output<typeof LoudnessMeasurementSchema>;

export type OpenRequest = ToolArgs<"open">;
export type OpenResult = ToolResult<"open">;
export type ContextResult = ToolOutput<"context">;
export type CaptureRequest = ToolArgs<"capture">;
export type CaptureResult = ToolResult<"capture">;
export type CheckRequest = ToolArgs<"check">;
export type QaSweepRequest = ToolArgs<"qa_sweep">;
export type QaSweepResult = ToolResult<"qa_sweep">;
export type QaSweepOutput = ToolOutput<"qa_sweep">;
export type CheckResult = ToolResult<"check">;
export type ExportRequest = ToolArgs<"export">;
export type AssetsSearchRequest = ToolArgs<"assets_search">;
export type AssetsSearchResult = ToolResult<"assets_search">;
export type AssetsImportRequest = ToolArgs<"assets_import">;
export type AssetsImportResult = ToolResult<"assets_import">;
export type ExportResult = ToolResult<"export">;
export type ModelsRequest = ToolArgs<"models">;
export type LogsRequest = ToolArgs<"logs">;
export type ScreenshotResult = ToolResult<"screenshot">;
export type ScreenshotOutput = ToolOutput<"screenshot">;
export type MediaProbeRequest = ToolArgs<"media_probe">;
export type MediaFrameRequest = ToolArgs<"media_grab">;
export type MediaFrameResult = ToolResult<"media_grab">;
export type MediaTranscribeRequest = ToolArgs<"media_transcribe">;
export type MediaTranscribeResult = ToolResult<"media_transcribe">;
export type MediaFilmstripRequest = ToolArgs<"media_filmstrip">;
export type MediaFilmstripResult = ToolResult<"media_filmstrip">;
export type MediaWaveformRequest = ToolArgs<"media_waveform">;
export type MediaWaveformResult = ToolResult<"media_waveform">;
export type MediaListenRequest = ToolArgs<"media_listen">;
export type MediaListenResult = ToolResult<"media_listen">;
export type MediaScenesRequest = ToolArgs<"media_scenes">;
export type MediaScenesResult = ToolResult<"media_scenes">;
export type MediaTrackRequest = ToolArgs<"media_track">;
export type MediaTrackResult = ToolResult<"media_track">;
export type MediaStabilizeRequest = ToolArgs<"media_stabilize">;
export type MediaStabilizeResult = ToolResult<"media_stabilize">;
export type MediaReframeRequest = ToolArgs<"media_reframe">;
export type MediaReframeResult = ToolResult<"media_reframe">;
export type MediaKeyRequest = ToolArgs<"media_key">;
export type MediaKeyResult = ToolResult<"media_key">;
export type MediaRetimeRequest = ToolArgs<"media_retime">;
export type MediaRetimeResult = ToolResult<"media_retime">;
export type MediaScopesRequest = ToolArgs<"media_scopes">;
export type MediaScopesResult = ToolResult<"media_scopes">;
export type MediaSegmentRequest = ToolArgs<"media_segment">;
export type MediaSegmentResult = ToolResult<"media_segment">;
export type MediaSegmentOutput = ToolOutput<"media_segment">;
export type MediaDepthRequest = ToolArgs<"media_depth">;
export type MediaDepthResult = ToolResult<"media_depth">;
export type MediaDepthOutput = ToolOutput<"media_depth">;
export type MediaFlowRequest = ToolArgs<"media_flow">;
export type MediaFlowResult = ToolResult<"media_flow">;
export type MediaFlowOutput = ToolOutput<"media_flow">;
export type TimelineEditRequest = ToolArgs<"timeline_edit">;
export type TimelineEditOutput = ToolOutput<"timeline_edit">;
export type AudioLoudnessRequest = ToolArgs<"audio_loudness">;
export type AudioLoudnessResult = ToolResult<"audio_loudness">;
export type AudioBeatsRequest = ToolArgs<"audio_beats">;
export type AudioBeatsResult = ToolResult<"audio_beats">;
export type FontsRequest = ToolArgs<"fonts">;
export type ReportRequest = ToolArgs<"report">;
