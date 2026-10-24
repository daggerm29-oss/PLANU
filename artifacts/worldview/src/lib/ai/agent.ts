import type { BridgeRef } from "./bridge";
import { ACTION_TOOLS, TOOL_DECLS } from "./tools";
import { executeTool, sceneContext } from "./executor";
import { parseLocalIntent } from "./fast-intents";

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface AiMessage {
  role: "user" | "assistant" | "tool";
  text?: string;
  images?: string[];
  toolCalls?: ToolCall[];
  toolResults?: { id: string; name: string; result: unknown }[];
  raw?: unknown;
}

export type Provider = "gemini" | "openai";

export interface Quota { rpm: number; rpd: number; usedMinute: number; usedToday: number; cooldownSec: number }

export type AgentEvent =
  | { type: "tool"; name: string; args: Record<string, unknown>; say?: string; ok: boolean }
  | { type: "thinking"; round: number };

export class AgentError extends Error {
  constructor(message: string, public retryAfterSec: number | null) { super(message); }
}

const SYSTEM = `You are WORLDVIEW COPILOT, the voice operator of a live 3D geospatial intelligence console (MapLibre globe + Cesium photorealistic 3D).
You can DIRECT the camera, ANNOTATE the world, INTERROGATE live data (ADS-B aircraft, AIS ships, satellites, infrastructure, hazards, launches, CCTV) and OPERATE every panel, using the tools.

Rules:
- Act, don't ask. Call tools immediately; batch every independent tool call in ONE response (e.g. fly_to + set_vision_mode together).
- Each user turn ends with [SCENE] JSON (camera, open panels, selection, live counts). Use it to resolve "here", "this", "that plane".
- "this/that" + entity = the selected entity; use inspect_selected for "what's this?".
- Live questions: call the query_* tool, then answer from its numbers only. Never invent data. If a feed is empty, say so.
- "planes overhead" / "show me X here": query with region "view", then frame_results.
- Routes: draw_route (walking/driving/cycling). "Fly the route" -> fly_route.
- Outlining a state/country/park/building -> annotate_place. Distances -> measure_distance.
- Visual questions at street level -> capture_view, then describe ONLY clearly legible signs/buildings; say when something is unreadable.
- Replies are spoken aloud: 1-2 short sentences, plain text, no markdown, no lists, round numbers, no ids unless asked.`;

const MAX_ROUNDS = 5;
const MAX_HISTORY = 16;
const SCENE_MARK = "\n\n[SCENE] ";

/** Keep the last N messages starting at a user turn; drop old images and old scene blobs to save tokens. */
function trimHistory(history: AiMessage[]): AiMessage[] {
  let start = Math.max(0, history.length - MAX_HISTORY);
  while (start < history.length && history[start].role !== "user") start++;
  return history.slice(start).map((m) => ({
    ...m,
    images: undefined,
    text: m.role === "user" && m.text?.includes(SCENE_MARK) ? m.text.slice(0, m.text.indexOf(SCENE_MARK)) : m.text,
  }));
}

async function callModel(base: string, provider: Provider, model: string | undefined, messages: AiMessage[]) {
  const res = await fetch(`${base}/api/ai/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, model, system: SYSTEM, messages, tools: TOOL_DECLS }),
  });
  const j = (await res.json().catch(() => ({}))) as { text?: string; toolCalls?: ToolCall[]; raw?: unknown; model?: string; quota?: Quota | null; error?: string; retryAfterSec?: number | null };
  if (!res.ok) {
    const fallback = res.status >= 500 ? `The model server didn't respond in time (HTTP ${res.status}). Try again in a moment.` : `HTTP ${res.status}`;
    throw new AgentError(j.error ?? fallback, j.retryAfterSec ?? null);
  }
  return { text: j.text ?? "", toolCalls: j.toolCalls ?? [], raw: j.raw, model: j.model ?? model ?? "", quota: j.quota ?? null };
}

export interface TurnResult {
  reply: string;
  history: AiMessage[];
  modelCalls: number;
  quota: Quota | null;
  model: string | null;
  local: boolean;
}

export async function runTurn(opts: {
  text: string;
  history: AiMessage[];
  provider: Provider;
  model?: string;
  bridgeRef: BridgeRef;
  base: string;
  onEvent?: (e: AgentEvent) => void;
}): Promise<TurnResult> {
  const { text, bridgeRef, base, onEvent } = opts;
  const ctx = { bridgeRef, base };

  // 1) Zero-cost local commands.
  const local = parseLocalIntent(text);
  if (local) {
    const says: string[] = [];
    for (const c of local) {
      const out = await executeTool(c.name, c.args, ctx);
      const ok = (out.result as { ok?: boolean })?.ok !== false;
      onEvent?.({ type: "tool", name: c.name, args: c.args, say: out.say, ok });
      if (out.say) says.push(out.say);
    }
    const reply = says.join(" ") || "Done.";
    return { reply, history: [...opts.history, { role: "user", text }, { role: "assistant", text: reply }], modelCalls: 0, quota: null, model: null, local: true };
  }

  // 2) Model loop.
  const messages = trimHistory(opts.history);
  messages.push({ role: "user", text: text + SCENE_MARK + JSON.stringify(sceneContext(bridgeRef.current)) });
  let reply = "";
  let quota: Quota | null = null;
  let model: string | null = null;
  let calls = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    onEvent?.({ type: "thinking", round });
    const out = await callModel(base, opts.provider, opts.model, messages);
    calls++;
    quota = out.quota ?? quota;
    model = out.model || model;
    messages.push({ role: "assistant", text: out.text, toolCalls: out.toolCalls.length ? out.toolCalls : undefined, raw: out.raw });
    if (!out.toolCalls.length) { reply = out.text; break; }

    const results: { id: string; name: string; result: unknown }[] = [];
    const images: string[] = [];
    const says: string[] = [];
    for (const c of out.toolCalls) {
      let res;
      try {
        res = await executeTool(c.name, c.args ?? {}, ctx);
      } catch (e) {
        res = { result: { ok: false, error: String((e as Error).message) } };
      }
      const ok = (res.result as { ok?: boolean })?.ok !== false;
      onEvent?.({ type: "tool", name: c.name, args: c.args ?? {}, say: res.say, ok });
      results.push({ id: c.id, name: c.name, result: res.result });
      if (res.image) images.push(res.image);
      if (res.say) says.push(res.say);
    }
    messages.push({ role: "tool", toolResults: results, images: images.length ? images : undefined });

    // Only console actions this round: confirmations are already known, skip the follow-up request.
    if (out.toolCalls.every((c) => ACTION_TOOLS.has(c.name))) {
      reply = out.text || says.join(" ") || "Done.";
      messages.push({ role: "assistant", text: reply });
      break;
    }
    if (round === MAX_ROUNDS - 1) {
      reply = out.text || says.join(" ") || "Done.";
      messages.push({ role: "assistant", text: reply });
    }
  }

  return { reply: reply || "Done.", history: messages, modelCalls: calls, quota, model, local: false };
}
