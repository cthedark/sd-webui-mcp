// src/tools/modules.ts
//
// Forge's "VAE / Text Encoder" selector over the API.
//
// How this state actually works, because it determines everything below:
//
//   * The selection lives in `shared.opts.forge_additional_modules`, a single
//     GLOBAL setting inside the running WebUI process. The host's own browser
//     UI and this MCP server read and write the same value.
//   * Therefore: whatever the host already loaded in the UI IS the active
//     selection here. There is nothing to re-load, and nothing to send on each
//     generation. Reading it back tells you what is live.
//   * Writing it via POST /sdapi/v1/options is persistent — it stays set for
//     every later request and is flushed to config.json, so it survives a
//     WebUI restart too.
//   * The non-sticky alternative is `override_settings` inside a txt2img /
//     img2img payload, which the WebUI reverts once the request finishes
//     (override_settings_restore_afterwards defaults to true). That is the
//     right tool for a one-off, and the wrong tool for "load this and keep it".
//   * Changing the selection forces Forge to drop and rebuild the loaded model,
//     which costs real seconds, so set-vae-modules compares first and does
//     nothing when the requested set already matches.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StableDiffusionAPI, SDModuleInfo } from "../api/sd-api.js";
import { SD_API_URL } from "../config.js";

const api = new StableDiffusionAPI(SD_API_URL);

function basename(p: string): string {
  return p.replace(/^.*[/\\]/, "");
}

/** Match a user-supplied name or path against the discovered module list. */
function resolveModule(requested: string, available: SDModuleInfo[]): SDModuleInfo | { error: string } {
  const exact = available.find(m => m.filename === requested || m.model_name === requested);
  if (exact) return exact;

  const needle = basename(requested).toLowerCase();
  const ci = available.filter(
    m => basename(m.filename).toLowerCase() === needle || m.model_name.toLowerCase() === needle
  );
  if (ci.length === 1) return ci[0];

  const partial = available.filter(
    m =>
      basename(m.filename).toLowerCase().includes(needle) ||
      m.model_name.toLowerCase().includes(needle)
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    return {
      error:
        `"${requested}" is ambiguous — it matches:\n` +
        partial.map(m => `• ${m.model_name}`).join("\n"),
    };
  }

  return {
    error:
      `"${requested}" not found among the VAE / Text Encoder files Forge has discovered. ` +
      `Run list-vae-modules to see the available names.`,
  };
}

/**
 * Forge's sentinel meaning "whatever the first pass used". When this is present
 * in hr_additional_modules, processing.py skips modules_change entirely, so the
 * hi-res pass inherits the loaded VAE / Text Encoder with no model reload.
 */
export const USE_SAME_MODULES = "Use same choices";

/**
 * Resolve VAE / Text Encoder names to the absolute paths Forge expects,
 * passing the USE_SAME_MODULES sentinel through untouched.
 *
 * Used for the hi-res pass, which takes its own module list: Forge Neo declares
 * `hr_additional_modules: list = field(default=None)` and then iterates it
 * without a None check, so omitting it from an enable_hr request crashes the
 * WebUI with "'NoneType' object is not iterable". It must always be a list.
 */
export async function resolveModuleSelection(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  if (names.includes(USE_SAME_MODULES)) return [USE_SAME_MODULES];

  const available = await api.getModules();
  const resolved: string[] = [];
  for (const name of names) {
    const match = resolveModule(name, available);
    if ("error" in match) throw new Error(match.error);
    resolved.push(match.filename);
  }
  return resolved;
}

export function registerModuleTools(server: McpServer): void {
  server.registerTool(
    "list-vae-modules",
    {
      description:
        "List the VAE / Text Encoder modules Forge has discovered, and show which ones are currently " +
        "loaded. The active selection is global server state shared with the WebUI's own browser tab, " +
        "so this reports exactly what the host has loaded right now.",
    },
    async () => {
      let modules: SDModuleInfo[];
      try {
        modules = await api.getModules();
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Could not list VAE / Text Encoder modules.\n\n` +
                `${error instanceof Error ? error.message : String(error)}\n\n` +
                `/sdapi/v1/sd-modules is Forge-specific. On stock AUTOMATIC1111 the equivalent is ` +
                `the single "sd_vae" setting instead.`,
            },
          ],
        };
      }

      let active: string[] = [];
      let activeError: string | undefined;
      try {
        active = await api.getActiveModules();
      } catch (error) {
        activeError = error instanceof Error ? error.message : String(error);
      }

      const activeSet = new Set(active.map(p => basename(p).toLowerCase()));

      const lines = modules.map(m => {
        const isActive = activeSet.has(basename(m.filename).toLowerCase());
        return `${isActive ? "● " : "○ "}${m.model_name}`;
      });

      const activeSection = activeError
        ? `Could not read the current selection: ${activeError}`
        : active.length
        ? `Currently loaded (${active.length}):\n` + active.map(p => `• ${basename(p)}`).join("\n")
        : `Currently loaded: none — the checkpoint's own baked-in VAE / text encoders are being used.`;

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${activeSection}\n\n` +
              `Available VAE / Text Encoder modules (● = loaded):\n\n${lines.join("\n")}\n\n` +
              `This selection is global and persistent: it is the same state as the WebUI's ` +
              `"VAE / Text Encoder" box, it stays set across generations, and it is saved to config.json. ` +
              `Use set-vae-modules to change it.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "set-vae-modules",
    {
      description:
        "Set which VAE / Text Encoder modules Forge loads. This is a persistent global change — it " +
        "stays in effect for every later generation and is shared with the WebUI's own tab. Changing it " +
        "forces a model reload, so this tool does nothing when the requested set already matches.",
      inputSchema: {
        modules: z
          .array(z.string())
          .describe(
            "Module names or paths from list-vae-modules (e.g. ['ae.safetensors', 'clip_l.safetensors', " +
            "'t5xxl_fp16.safetensors']). Pass an empty array to clear the selection and fall back to the " +
            "checkpoint's built-in VAE / text encoders."
          ),
        mode: z
          .enum(["replace", "add"])
          .default("replace")
          .describe("'replace' sets exactly this list; 'add' merges these into what is already loaded"),
      },
    },
    async ({ modules, mode }) => {
      let available: SDModuleInfo[];
      try {
        available = await api.getModules();
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not read the module list.\n\n${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }

      const resolved: string[] = [];
      const problems: string[] = [];
      for (const requested of modules) {
        const match = resolveModule(requested, available);
        if ("error" in match) {
          problems.push(match.error);
        } else {
          resolved.push(match.filename);
        }
      }

      if (problems.length) {
        return { content: [{ type: "text" as const, text: problems.join("\n\n") }] };
      }

      let current: string[];
      try {
        current = await api.getActiveModules();
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not read the current selection.\n\n${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }

      const target =
        mode === "add" ? [...current, ...resolved.filter(p => !current.includes(p))] : resolved;

      const same =
        target.length === current.length && target.every((p, i) => p === current[i]);

      if (same) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Already loaded — no change made and no model reload triggered.\n\n` +
                (target.length
                  ? target.map(p => `• ${basename(p)}`).join("\n")
                  : "(no additional modules; using the checkpoint's built-in VAE / text encoders)"),
            },
          ],
        };
      }

      try {
        await api.setActiveModules(target);
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to set the modules.\n\n${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `VAE / Text Encoder selection updated. Forge will rebuild the model on the next generation.\n\n` +
              `Was:\n` +
              (current.length ? current.map(p => `• ${basename(p)}`).join("\n") : "• (none)") +
              `\n\nNow:\n` +
              (target.length ? target.map(p => `• ${basename(p)}`).join("\n") : "• (none)") +
              `\n\nThis is persistent: it stays set for subsequent requests, is written to config.json, ` +
              `and is the same setting the WebUI's own tab shows (that tab may need a page refresh to ` +
              `display the new value).`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "get-sd-settings",
    {
      description:
        "Show the WebUI's current global generation state — active checkpoint, VAE / Text Encoder " +
        "modules, CLIP skip and related settings — so you can confirm what the host actually has loaded " +
        "before generating.",
      inputSchema: {
        keys: z
          .array(z.string())
          .optional()
          .describe("Optional explicit option keys to read instead of the default summary set"),
      },
    },
    async ({ keys }) => {
      let options: Record<string, unknown>;
      try {
        options = await api.getOptions();
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not read settings.\n\n${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }

      const interesting = keys ?? [
        "sd_model_checkpoint",
        "forge_additional_modules",
        "forge_unet_storage_dtype",
        "forge_inference_memory",
        "sd_vae",
        "CLIP_stop_at_last_layers",
        "eta_noise_seed_delta",
        "img2img_fix_steps",
        "samples_save",
        "outdir_samples",
        "outdir_txt2img_samples",
      ];

      const lines = interesting
        .filter(k => k in options)
        .map(k => {
          const value = options[k];
          if (Array.isArray(value)) {
            return value.length
              ? `${k}:\n` + value.map(v => `    • ${basename(String(v))}`).join("\n")
              : `${k}: (empty)`;
          }
          return `${k}: ${value === "" ? "(empty)" : JSON.stringify(value)}`;
        });

      const missing = interesting.filter(k => !(k in options));

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Current WebUI settings:\n\n${lines.join("\n")}` +
              (missing.length ? `\n\nNot present in this build: ${missing.join(", ")}` : "") +
              `\n\nThese are the live global values used by every generation, whether it comes from ` +
              `this MCP server or from the WebUI's own browser tab.`,
          },
        ],
      };
    }
  );
}
