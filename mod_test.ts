import { classify, generate, generateVideo } from "./mod.ts";

function fake(calls: unknown[], final: unknown): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const data = url.endsWith("/api/ai/generate") ? { id: "row1" } : final;
    return new Response(JSON.stringify({ code: 0, data }));
  }) as unknown as typeof fetch;
}

function eq(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

Deno.test("image prefers the clean file", async () => {
  const calls: any[] = [];
  const url = await generate("x", { apiKey: "sk", pollEvery: 0, fetch: fake(calls, { images: ["m"], cleanImages: ["c"] }) });
  eq(url, "c");
  eq(calls[0].body.model, "saymaker-image-v1");
  eq(calls[1].body, { taskId: "row1" });
});

Deno.test("video routes by model", async () => {
  const calls: any[] = [];
  const url = await generateVideo("x", { apiKey: "sk", duration: 6, pollEvery: 0, fetch: fake(calls, { videos: ["v"] }) });
  eq(url, "v");
  eq([calls[0].body.provider, calls[0].body.scene, calls[0].body.options.duration], ["vgenv", "text-to-video", 6]);
});

Deno.test("classify", () => {
  eq(classify("insufficient credits").kind, "quota");
  eq(classify("invalid API key").kind, "auth");
  eq(classify("Your current run is rendering. Plans on the pricing page").kind, "busy");
});
