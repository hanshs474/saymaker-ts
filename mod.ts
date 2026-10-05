/**
 * Generate images and video on SayMaker (https://saymaker.ai) from
 * TypeScript or JavaScript.
 *
 * ```ts
 * import { generate, generateVideo } from "@saymaker/saymaker";
 * const url = await generate("a paper-cut layered mountain range at dusk");
 * const clip = await generateVideo("a fox trotting through snow", { duration: 6 });
 * ```
 *
 * One API key runs the whole shelf on your own credits: Veo 3.1, Kling 3.0,
 * Seedance 2.0, MiniMax H3, Nano Banana 2, GPT Image 2.5, Seedream 5.0 and
 * more. Create a key at https://saymaker.ai/settings/apikeys and set
 * `SAYMAKER_API_KEY` or pass `apiKey`. Uses the global `fetch`; no dependencies.
 *
 * @module
 */

export const BASE_URL = "https://saymaker.ai";
export const KEYS_URL = `${BASE_URL}/settings/apikeys`;
/** The cheapest text-to-image model. */
export const MODEL_IMAGE = "saymaker-image-v1";
/** The default edit model; it takes an input image. */
export const MODEL_EDIT = "nano-banana-2-lite";
/** The video model a free account can run (480p or 768p, 4 to 15 seconds). */
export const MODEL_VIDEO = "minimax-h3-fast";

/** Model id -> the routing field the API expects next to it. Unlisted ids go as "kie". */
export const MODELS: Readonly<Record<string, string>> = {
  "saymaker-image-v1": "kie", "nano-banana-2-lite": "kie", "nano-banana-2": "poyo",
  "nano-banana-pro": "poyo", "gpt-image-2": "poyo", "gpt-image-2-5-flare": "kie",
  "seedream-5-lite": "poyo", "seedream-5-pro": "kie", "qwen-image-3-pro": "kie",
  "grok-imagine-image-2-0": "poyo", "minimax-h3-fast": "vgenv", "minimax-h3": "poyo",
  "seedance-2": "kie", "seedance-2-fast": "kie", "seedance-2-5": "kie", "veo-3-1": "kie",
  "kling-3-0": "kie", "kling-3-0-turbo": "kie", "wan-3-0": "kie", "ltx-2-5-fast": "replicate",
};

/** Base class. Check `kind` to decide what to do next. */
export class SayMakerError extends Error {
  constructor(
    message: string,
    /** auth: no or bad key · quota: out of credits · plan: model needs a plan or pack ·
     *  busy: another run is still rendering · rejected: reword the prompt · other */
    readonly kind: "auth" | "quota" | "plan" | "busy" | "rejected" | "timeout" | "other" = "other",
  ) {
    super(message);
    this.name = "SayMakerError";
  }
}

interface Common {
  /** Defaults to the `SAYMAKER_API_KEY` environment variable. */
  apiKey?: string;
  model?: string;
  /** A public http(s) url: the photo to edit, or the first frame of a clip. */
  imageUrl?: string;
  aspectRatio?: string;
  /** Milliseconds. */
  timeout?: number;
  /** Milliseconds between polls. */
  pollEvery?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export type ImageOptions = Common;

export interface VideoOptions extends Common {
  /** Seconds, where the model offers a choice. */
  duration?: number;
  /** e.g. "480p", "720p", "1080p". */
  resolution?: string;
  /** Ask for sound where the model writes it in the same pass. Default true. */
  sound?: boolean;
}

function envKey(): string | undefined {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  try {
    return g.process?.env?.SAYMAKER_API_KEY ?? g.Deno?.env?.get("SAYMAKER_API_KEY");
  } catch {
    return undefined; // Deno without --allow-env
  }
}

/** Map a refusal to the error kind that says what to do next. */
export function classify(message: string, data?: { busy?: unknown }): SayMakerError {
  const low = message.toLowerCase();
  if (data?.busy || low.includes("is rendering") || low.includes("at once")) return new SayMakerError(message, "busy");
  if (low.includes("api key") || low.includes("no auth")) return new SayMakerError(message, "auth");
  if (low.includes("insufficient credits")) return new SayMakerError(message, "quota");
  if (low.includes("subscription") || low.includes("plan") || low.includes("sign in")) return new SayMakerError(message, "plan");
  return new SayMakerError(message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(
  media: "image" | "video",
  scene: string,
  model: string,
  prompt: string,
  options: Record<string, unknown>,
  o: Common,
  defPoll: number,
  defTimeout: number,
): Promise<string> {
  if (!prompt?.trim()) throw new TypeError("prompt is required");
  const key = o.apiKey || envKey();
  if (!key) throw new SayMakerError(`pass apiKey or set SAYMAKER_API_KEY; create a key at ${KEYS_URL}`, "auth");
  const f = o.fetch ?? fetch;
  const base = o.baseUrl ?? BASE_URL;
  const post = async (path: string, body: unknown) => {
    const res = await f(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { code: number; message?: string; data?: Record<string, unknown> };
  };

  const env = await post("/api/ai/generate", {
    provider: MODELS[model] ?? "kie", mediaType: media, model, scene, prompt, options,
  });
  // Refusals answer HTTP 200 with code -1; the status code alone reads as success.
  if (env.code !== 0) throw classify(env.message ?? "request refused", env.data);
  // A signed-out request is also a 200 with code 0 — only `wall` tells it apart.
  if (env.data?.wall) throw new SayMakerError(`SayMaker needs an API key; create one at ${KEYS_URL}`, "auth");
  const id = env.data?.id;
  if (!id) throw new SayMakerError("the service returned no task id");

  // Free-account runs only reach the model on the poll that crosses the end of
  // the queue wait, so polling is what starts the work.
  const deadline = Date.now() + (o.timeout ?? defTimeout);
  while (Date.now() < deadline) {
    await sleep(o.pollEvery ?? defPoll);
    let q;
    try {
      q = await post("/api/ai/query", { taskId: id });
    } catch {
      continue; // a dropped poll is not a failed generation
    }
    if (q.code !== 0) continue;
    const d = q.data ?? {};
    for (const field of ["cleanImages", "images", "videos"]) {
      const list = d[field];
      if (Array.isArray(list) && list.length) return String(list[0]);
    }
    if (["failed", "error"].includes(String(d.status ?? "").toLowerCase())) {
      throw new SayMakerError("the run failed; reword the prompt rather than retrying", "rejected");
    }
  }
  throw new SayMakerError("deadline passed; the run may still finish in your SayMaker history", "timeout");
}

function checkUrl(u?: string) {
  if (u !== undefined && !/^https?:\/\//.test(u)) throw new TypeError("imageUrl must be a public http(s) url");
}

/** Generate one image, or edit `imageUrl`, and resolve to its URL. */
export function generate(prompt: string, o: ImageOptions = {}): Promise<string> {
  checkUrl(o.imageUrl);
  const edit = o.imageUrl !== undefined;
  const options: Record<string, unknown> = { size: o.aspectRatio ?? (edit ? "auto" : "1:1"), resolution: "1K", n: 1 };
  if (edit) options.image_input = [o.imageUrl];
  return run("image", edit ? "image-to-image" : "text-to-image", o.model ?? (edit ? MODEL_EDIT : MODEL_IMAGE), prompt, options, o, 5_000, 4_500_000);
}

/** Generate one clip, or animate `imageUrl` as the first frame, and resolve to its URL. */
export function generateVideo(prompt: string, o: VideoOptions = {}): Promise<string> {
  checkUrl(o.imageUrl);
  const options: Record<string, unknown> = { aspect_ratio: o.aspectRatio ?? "16:9", sound: o.sound ?? true };
  if (o.imageUrl) options.image_input = [o.imageUrl];
  if (o.duration) options.duration = o.duration;
  if (o.resolution) options.resolution = o.resolution;
  return run("video", o.imageUrl ? "image-to-video" : "text-to-video", o.model ?? MODEL_VIDEO, prompt, options, o, 10_000, 5_400_000);
}
