"use server";

import { createSupabaseAdminClient, hasSupabaseAdminEnv } from "@/lib/supabase";

export type PythonAnalyzeResponse = {
  videoId?: string;
  video_id?: string;
  thumbnailUrl?: string;
  thumbnail_url?: string;
  performanceScore?: number;
  performance_score?: number;
  improvementSuggestions?: unknown;
  suggestions?: unknown;
  /** Some UIs may send display-label keys; supported defensively. */
  [key: string]: unknown;
};

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function coerceSuggestions(value: unknown): unknown {
  // Prefer arrays of strings, but allow any JSON-ish object.
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  if (value && typeof value === "object") return value;
  return [];
}

function mapAnalysisToInsertRow(analysis: PythonAnalyzeResponse) {
  const ytVideoId =
    (typeof analysis.videoId === "string" && analysis.videoId) ||
    (typeof analysis.video_id === "string" && analysis.video_id) ||
    (typeof analysis["Video ID"] === "string" && (analysis["Video ID"] as string)) ||
    null;

  const imageUrl =
    (typeof analysis.thumbnailUrl === "string" && analysis.thumbnailUrl) ||
    (typeof analysis.thumbnail_url === "string" && analysis.thumbnail_url) ||
    (typeof analysis["thumbnailUrl"] === "string" && (analysis["thumbnailUrl"] as string)) ||
    (typeof analysis["thumbnail_url"] === "string" && (analysis["thumbnail_url"] as string)) ||
    null;

  const performanceScore =
    coerceNumber(analysis.performanceScore) ??
    coerceNumber(analysis.performance_score) ??
    coerceNumber(analysis["Performance Score"]) ??
    null;

  const suggestions = coerceSuggestions(
    analysis.improvementSuggestions ?? analysis.suggestions ?? analysis["Suggestions"],
  );

  if (!ytVideoId) throw new Error("Missing video id in analysis response.");
  if (performanceScore === null) throw new Error("Missing performance score in analysis response.");

  return {
    // Assumes your Supabase table has these snake_case columns.
    yt_video_id: ytVideoId,
    performance_score: performanceScore,
    ai_suggestions: suggestions,
    image_url: imageUrl,
  };
}

/**
 * Server Action: persist the Python /analyze response into Supabase.
 * Writes to `thumbnail_iterations`.
 */
export async function saveThumbnailIterationFromAnalysis(analysis: PythonAnalyzeResponse) {
  if (!hasSupabaseAdminEnv()) {
    // Local dev convenience: don't crash the app if Supabase isn't configured.
    return { id: null as string | null, skipped: true as const };
  }

  const supabase = createSupabaseAdminClient();
  const row = mapAnalysisToInsertRow(analysis);

  const { data, error } = await supabase
    .from("thumbnail_iterations")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    // Surface details for debugging in server logs.
    throw new Error(`Failed to save thumbnail iteration: ${error.message}`);
  }

  return { id: data.id as string };
}
