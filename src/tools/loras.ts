// src/tools/loras.ts
//
// LoRA discovery and prompt injection.
//
// The /sdapi/v1/loras and /sdapi/v1/refresh-loras endpoints are registered by
// the built-in "Lora" extension, not by core api.py. They are present on stock
// AUTOMATIC1111 and on Forge, but will 404 if that built-in extension has been
// disabled — the error message says so rather than pretending there are none.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StableDiffusionAPI, SDLoraInfo } from "../api/sd-api.js";
import { SD_API_URL } from "../config.js";

const api = new StableDiffusionAPI(SD_API_URL);

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * safetensors metadata values arrive either already parsed or as JSON strings,
 * depending on the trainer that wrote them. Normalise both.
 */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * Pull likely trigger words out of ss_tag_frequency. Kohya writes it as
 * { "<dataset dir>": { "<tag>": <count>, ... }, ... }. The highest-count tags
 * are, in practice, the activation tags for the LoRA.
 */
export function extractTriggerWords(metadata: Record<string, unknown> | undefined, limit = 8): string[] {
  if (!metadata) return [];

  // Some trainers write an explicit list; prefer it when present.
  const explicit = parseMaybeJson(metadata["ss_trigger_words"] ?? metadata["trigger_words"] ?? metadata["activation text"]);
  if (Array.isArray(explicit) && explicit.length) {
    return explicit.map(String).slice(0, limit);
  }
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.split(",").map(s => s.trim()).filter(Boolean).slice(0, limit);
  }

  const freq = parseMaybeJson(metadata["ss_tag_frequency"]);
  if (!freq || typeof freq !== "object") return [];

  const counts = new Map<string, number>();
  for (const bucket of Object.values(freq as Record<string, unknown>)) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const [tag, count] of Object.entries(bucket as Record<string, unknown>)) {
      const n = typeof count === "number" ? count : Number(count);
      if (!Number.isFinite(n)) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + n);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

/** Best-effort base-model label, so SD1.5 LoRAs are not mixed into SDXL runs. */
export function extractBaseModel(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const version = metadata["ss_base_model_version"];
  if (typeof version === "string" && version.trim()) return version.trim();
  const modelName = metadata["ss_sd_model_name"];
  if (typeof modelName === "string" && modelName.trim()) return modelName.trim();
  return undefined;
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

export class LoraResolutionError extends Error {}

function normalise(value: string): string {
  return value
    .replace(/^.*[/\\]/, "")     // drop any directory prefix
    .replace(/\.(safetensors|ckpt|pt|bin)$/i, "")
    .toLowerCase();
}

/**
 * Map a user-supplied LoRA name onto the exact name the WebUI expects inside a
 * <lora:...> tag. Exact match wins; otherwise a unique case-insensitive
 * substring match on the name or alias. Ambiguity is an error, not a guess —
 * silently picking the wrong LoRA is much worse than asking again.
 */
export function resolveLoraName(requested: string, available: SDLoraInfo[]): string {
  if (available.length === 0) return requested;

  const exact = available.find(l => l.name === requested || l.alias === requested);
  if (exact) return exact.name;

  const needle = normalise(requested);
  const ci = available.find(l => normalise(l.name) === needle || normalise(l.alias ?? "") === needle);
  if (ci) return ci.name;

  const partial = available.filter(
    l => normalise(l.name).includes(needle) || normalise(l.alias ?? "").includes(needle)
  );
  if (partial.length === 1) return partial[0].name;
  if (partial.length > 1) {
    throw new LoraResolutionError(
      `LoRA "${requested}" is ambiguous — it matches ${partial.length} entries:\n` +
      partial.map(l => `• ${l.name}`).join("\n") +
      `\n\nUse the full name from list-loras.`
    );
  }

  throw new LoraResolutionError(
    `LoRA "${requested}" not found. Run list-loras to see what is installed, ` +
    `or refresh-loras if you just added the file.`
  );
}

export interface LoraRequest {
  name: string;
  weight?: number;
  te_weight?: number;
}

/**
 * Build the `<lora:name:weight>` tags the WebUI parses out of the prompt.
 * A second weight, when given, is the text-encoder weight.
 */
export function buildLoraTags(loras: LoraRequest[] | undefined, available: SDLoraInfo[]): string {
  if (!loras || loras.length === 0) return "";
  return loras
    .map(l => {
      const name = resolveLoraName(l.name, available);
      const unet = l.weight ?? 1;
      return l.te_weight === undefined
        ? `<lora:${name}:${unet}>`
        : `<lora:${name}:${unet}:${l.te_weight}>`;
    })
    .join(" ");
}

/**
 * Fetch the LoRA list for name resolution, tolerating a WebUI that does not
 * expose the endpoint: in that case we fall back to passing names through
 * verbatim rather than failing the whole generation.
 */
export async function loadLorasForResolution(): Promise<SDLoraInfo[]> {
  try {
    return await api.getLoras();
  } catch (error) {
    console.error("Could not fetch LoRA list for name resolution:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Zod schema fragment shared with the image tools
// ---------------------------------------------------------------------------

export const loraArraySchema = z
  .array(
    z.object({
      name: z.string().describe("LoRA name or alias as reported by list-loras (partial names are resolved)"),
      weight: z.number().default(1).describe("UNet weight, typically 0.4-1.0 (default: 1)"),
      te_weight: z.number().optional().describe("Optional separate text-encoder weight"),
    })
  )
  .optional()
  .describe("LoRAs to apply. The <lora:name:weight> tags are appended to the prompt automatically.");

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerLoraTools(server: McpServer): void {
  server.registerTool(
    "list-loras",
    {
      description:
        "List all LoRAs available to the Stable Diffusion WebUI, with their aliases, " +
        "likely trigger words and base model. Use the reported name in generate-image's loras parameter.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe("Optional case-insensitive substring to filter LoRA names by"),
        show_triggers: z
          .boolean()
          .default(true)
          .describe("Include likely trigger words parsed from training metadata (default: true)"),
      },
    },
    async ({ filter, show_triggers }) => {
      let loras: SDLoraInfo[];
      try {
        loras = await api.getLoras();
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Could not list LoRAs.\n\n${error instanceof Error ? error.message : String(error)}` }],
        };
      }

      const filtered = filter
        ? loras.filter(l =>
            l.name.toLowerCase().includes(filter.toLowerCase()) ||
            (l.alias ?? "").toLowerCase().includes(filter.toLowerCase())
          )
        : loras;

      if (filtered.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: filter
                ? `No LoRAs match "${filter}" (${loras.length} installed in total).`
                : "No LoRAs installed. Put .safetensors files in models/Lora and run refresh-loras.",
            },
          ],
        };
      }

      const lines = filtered.map(l => {
        const parts = [`• ${l.name}`];
        if (l.alias && l.alias !== l.name) parts.push(`  alias: ${l.alias}`);
        const base = extractBaseModel(l.metadata);
        if (base) parts.push(`  base: ${base}`);
        if (show_triggers) {
          const triggers = extractTriggerWords(l.metadata);
          if (triggers.length) parts.push(`  triggers: ${triggers.join(", ")}`);
        }
        return parts.join("\n");
      });

      const header = filter
        ? `${filtered.length} of ${loras.length} LoRAs match "${filter}":`
        : `${filtered.length} LoRAs available:`;

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${header}\n\n${lines.join("\n\n")}\n\n` +
              `Apply one via generate-image's loras parameter, e.g. ` +
              `loras: [{ "name": "${filtered[0].name}", "weight": 0.8 }]. ` +
              `Trigger words are a best-effort guess from training metadata — ` +
              `add the ones you want to the prompt yourself.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "refresh-loras",
    {
      description: "Rescan the LoRA directory so newly added files become visible without restarting the WebUI",
    },
    async () => {
      try {
        await api.refreshLoras();
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to refresh LoRAs.\n\n${error instanceof Error ? error.message : String(error)}` }],
        };
      }

      let count = "an unknown number of";
      try {
        count = String((await api.getLoras()).length);
      } catch {
        /* the refresh itself succeeded; the follow-up count is a nicety */
      }

      return {
        content: [{ type: "text" as const, text: `LoRA directory rescanned. ${count} LoRAs now available.` }],
      };
    }
  );
}
