"use server";

import { createSupabaseAdminClient, hasSupabaseAdminEnv } from "@/lib/supabase";

export type ThumbnailIterationRow = {
  id: string;
  yt_video_id: string;
  performance_score: number;
  ai_suggestions: unknown;
  created_at: string;
  image_url?: string | null;
};

export async function fetchLatestThumbnailIterations(limit: number = 12): Promise<ThumbnailIterationRow[]> {
  if (!hasSupabaseAdminEnv()) {
    // Local dev convenience: don't crash the app if Supabase isn't configured.
    return [];
  }

  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("thumbnail_iterations")
    .select("id, yt_video_id, performance_score, ai_suggestions, created_at, image_url")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch thumbnail iterations: ${error.message}`);
  return (data ?? []) as ThumbnailIterationRow[];
}
