// src/tools/extras.ts
//
// The "Extras" tab over the API: pure upscaling and face restoration with no
// diffusion pass, plus discovery of what extensions/scripts the WebUI actually
// has loaded (which is how you find out what alwayson_scripts names are valid).

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StableDiffusionAPI } from "../api/sd-api.js";
import { SD_API_URL, GENERATION_WAIT_SECONDS } from "../config.js";
import { fetchAdetailerModels } from "./alwayson.js";
import {
  validateImagePath,
  readImageAsBase64,
  saveBase64Image,
  imageDimensions,
  createErrorResponse,
} from "../utils/image-io.js";
import { runAsJob, ProgressContext } from "./job-response.js";

const api = new StableDiffusionAPI(SD_API_URL);

export function registerExtrasTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  server.registerTool(
    "list-upscalers",
    {
      description:
        "List upscalers available for the extras/upscale-image tool and for hi-res fix " +
        "(ESRGAN, R-ESRGAN, SwinIR, DAT, plus any added by extensions), and the latent upscale modes.",
    },
    async () => {
      try {
        const upscalers = await api.getUpscalers();
        const usable = upscalers.filter(u => u.name && u.name !== "None");

        let latentSection = "";
        try {
          const latent = await api.getLatentUpscaleModes();
          if (latent.length) {
            latentSection =
              `\n\nLatent modes (hi-res fix only, not valid for upscale-image):\n` +
              latent.map(m => `• ${m.name}`).join("\n");
          }
        } catch {
          /* optional endpoint; skip quietly */
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Upscalers available for upscale-image and hr_upscaler:\n\n` +
                usable
                  .map(u => `• ${u.name}${u.scale ? ` (native scale ${u.scale}x)` : ""}`)
                  .join("\n") +
                latentSection,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Could not list upscalers.\n\n${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.registerTool(
    "list-adetailer-models",
    {
      description:
        "List the detector models the ADetailer-Neo extension has available (YOLO .pt and MediaPipe " +
        "detectors), read from the live dropdown choices. Use one of these names in the adetailer " +
        "parameter of generate-image or edit-image.",
    },
    async () => {
      const models = await fetchAdetailerModels();

      if (models.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Could not read ADetailer's detector list. Either the ADetailer-Neo extension is not " +
                "installed/enabled, or /sdapi/v1/script-info is unavailable. Run list-extensions to check.",
            },
          ],
        };
      }

      const yolo = models.filter(m => /\.pt$/i.test(m));
      const other = models.filter(m => !/\.pt$/i.test(m));

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${models.length} ADetailer detectors available:\n\n` +
              (yolo.length ? `YOLO:\n` + yolo.map(m => `\u2022 ${m}`).join("\n") : "") +
              (other.length ? `${yolo.length ? "\n\n" : ""}MediaPipe / other:\n` + other.map(m => `\u2022 ${m}`).join("\n") : "") +
              `\n\nExample: adetailer: [{ "model": "${yolo[0] ?? models[0]}", "denoising_strength": 0.35 }]`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "list-extensions",
    {
      description:
        "List extensions installed in the Stable Diffusion WebUI, and the scripts they register. " +
        "Use this to discover which alwayson_scripts names this server accepts, and the argument order " +
        "each script expects.",
      inputSchema: {
        include_scripts: z
          .boolean()
          .default(true)
          .describe("Also list the txt2img/img2img scripts registered by extensions (default: true)"),
        script_details: z
          .string()
          .optional()
          .describe("Name of one script to show the full argument list for (from /sdapi/v1/script-info)"),
      },
    },
    async ({ include_scripts, script_details }) => {
      const sections: string[] = [];

      try {
        const extensions = await api.getExtensions();
        if (extensions.length === 0) {
          sections.push("No extensions installed (only built-ins are active).");
        } else {
          const enabled = extensions.filter(e => e.enabled);
          const disabled = extensions.filter(e => !e.enabled);
          sections.push(
            `Installed extensions (${enabled.length} enabled, ${disabled.length} disabled):\n\n` +
              enabled.map(e => `• ${e.name}${e.version ? ` @ ${e.version}` : ""}`).join("\n") +
              (disabled.length ? `\n\nDisabled:\n` + disabled.map(e => `• ${e.name}`).join("\n") : "")
          );
        }
      } catch (error) {
        sections.push(`Could not list extensions: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (include_scripts) {
        try {
          const scripts = await api.getScripts();
          sections.push(
            `Scripts registered for txt2img:\n` +
              (scripts.txt2img?.length ? scripts.txt2img.map(s => `• ${s}`).join("\n") : "(none)") +
              `\n\nScripts registered for img2img:\n` +
              (scripts.img2img?.length ? scripts.img2img.map(s => `• ${s}`).join("\n") : "(none)")
          );
        } catch (error) {
          sections.push(`Could not list scripts: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (script_details) {
        try {
          const info = await api.getScriptInfo();
          const match = info.find(s => s.name?.toLowerCase() === script_details.toLowerCase()) ??
            info.find(s => s.name?.toLowerCase().includes(script_details.toLowerCase()));

          if (!match) {
            sections.push(
              `No script named "${script_details}". Available: ${info.map(s => s.name).join(", ")}`
            );
          } else {
            const args = match.args ?? [];
            sections.push(
              `Arguments for "${match.name}" (alwayson: ${match.is_alwayson}, img2img: ${match.is_img2img}) — ` +
                `${args.length} positional args, in order:\n\n` +
                args
                  .map((a, i) => {
                    const bits = [`${i}. ${a.label ?? "(unlabelled)"}`];
                    if (a.value !== undefined) bits.push(`default=${JSON.stringify(a.value)}`);
                    if (Array.isArray(a.choices) && a.choices.length) {
                      const shown = a.choices.slice(0, 12).map(c => String(c)).join(", ");
                      bits.push(`choices=[${shown}${a.choices.length > 12 ? ", …" : ""}]`);
                    }
                    return bits.join("  ");
                  })
                  .join("\n")
            );
          }
        } catch (error) {
          sections.push(`Could not fetch script info: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return { content: [{ type: "text" as const, text: sections.join("\n\n---\n\n") }] };
    }
  );

  // -------------------------------------------------------------------------
  // Upscaling
  // -------------------------------------------------------------------------

  server.registerTool(
    "upscale-image",
    {
      description:
        "Upscale an existing image using the WebUI's Extras tab (a pure upscaler pass — no diffusion, " +
        "so nothing in the image changes except resolution). Optionally blend a second upscaler and " +
        "apply face restoration. For a creative upscale that adds detail, use generate-image with " +
        "enable_hr instead, or edit-image at low denoising strength.",
      inputSchema: {
        image_path: z.string().describe("Path to the image file to upscale"),
        upscaler: z
          .string()
          .default("R-ESRGAN 4x+")
          .describe("Upscaler name from list-upscalers (default: R-ESRGAN 4x+)"),
        scale: z.number().default(2).describe("Upscale factor when resize_mode is 'multiplier' (default: 2)"),
        resize_mode: z
          .enum(["multiplier", "dimensions"])
          .default("multiplier")
          .describe("'multiplier' scales by `scale`; 'dimensions' targets target_width/target_height"),
        target_width: z.number().optional().describe("Target width when resize_mode is 'dimensions'"),
        target_height: z.number().optional().describe("Target height when resize_mode is 'dimensions'"),
        crop_to_fit: z
          .boolean()
          .default(true)
          .describe("When resize_mode is 'dimensions', crop to exactly fill the target (default: true)"),
        second_upscaler: z
          .string()
          .optional()
          .describe("Optional second upscaler to blend with the first"),
        second_upscaler_visibility: z
          .number()
          .default(0.5)
          .describe("Blend weight of the second upscaler, 0.0-1.0 (default: 0.5)"),
        gfpgan_visibility: z
          .number()
          .default(0)
          .describe("GFPGAN face restoration strength, 0.0-1.0 (default: 0 = off)"),
        codeformer_visibility: z
          .number()
          .default(0)
          .describe("CodeFormer face restoration strength, 0.0-1.0 (default: 0 = off)"),
        codeformer_weight: z
          .number()
          .default(0)
          .describe("CodeFormer fidelity weight, 0 = max effect, 1 = max fidelity (default: 0)"),
        upscale_first: z
          .boolean()
          .default(false)
          .describe("Run the upscaler before face restoration instead of after (default: false)"),
        wait_seconds: z
          .number()
          .optional()
          .describe(
            `How long to wait before returning a job id instead (default: ${GENERATION_WAIT_SECONDS}s). ` +
            `The upscale continues either way; collect it with check-generation.`
          ),
      },
    },
    async ({
      image_path,
      upscaler,
      scale,
      resize_mode,
      target_width,
      target_height,
      crop_to_fit,
      second_upscaler,
      second_upscaler_visibility,
      gfpgan_visibility,
      codeformer_visibility,
      codeformer_weight,
      upscale_first,
      wait_seconds,
    }, extra) => {
      try {
        if (!(await validateImagePath(image_path))) {
          return createErrorResponse(
            `Invalid image path: ${image_path}. Please specify a path to a valid image file.`
          );
        }

        if (resize_mode === "dimensions" && (!target_width || !target_height)) {
          return createErrorResponse(
            "resize_mode 'dimensions' requires both target_width and target_height."
          );
        }

        if (!(await api.checkStatus())) {
          return createErrorResponse("Cannot connect to Stable Diffusion API. Please ensure WebUI is running.");
        }

        // Validate the upscaler name up front — the extras endpoint silently
        // falls back to a no-op on an unknown name, which looks like success.
        try {
          const available = await api.getUpscalers();
          const names = available.map(u => u.name);
          const resolve = (want: string | undefined): string | undefined => {
            if (!want) return undefined;
            const exact = names.find(n => n.toLowerCase() === want.toLowerCase());
            if (exact) return exact;
            const partial = names.filter(n => n.toLowerCase().includes(want.toLowerCase()));
            if (partial.length === 1) return partial[0];
            return undefined;
          };

          const resolved = resolve(upscaler);
          if (!resolved) {
            return createErrorResponse(
              `Upscaler "${upscaler}" not found. Available upscalers:\n\n` +
                names.filter(n => n !== "None").map(n => `• ${n}`).join("\n")
            );
          }
          upscaler = resolved;

          if (second_upscaler) {
            const resolvedSecond = resolve(second_upscaler);
            if (!resolvedSecond) {
              return createErrorResponse(
                `Second upscaler "${second_upscaler}" not found. Available upscalers:\n\n` +
                  names.filter(n => n !== "None").map(n => `• ${n}`).join("\n")
              );
            }
            second_upscaler = resolvedSecond;
          }
        } catch (error) {
          console.error("Upscaler validation skipped:", error);
        }

        const before = await imageDimensions(image_path);
        console.error(
          `Upscale request: ${image_path} (${before.width}x${before.height}) via ${upscaler}, mode=${resize_mode}`
        );

        const base64Input = await readImageAsBase64(image_path);
        const upscalerLabel =
          upscaler + (second_upscaler ? ` + ${second_upscaler} @ ${second_upscaler_visibility}` : "");

        return await runAsJob({
          kind: "upscale",
          label: `${upscalerLabel} on ${image_path}`,
          headline: `Upscaled with ${upscalerLabel}`,
          details: `\nSource: ${image_path} (${before.width}x${before.height})`,
          waitSeconds: wait_seconds ?? GENERATION_WAIT_SECONDS,
          context: extra as ProgressContext,
          work: async () => {
            const resultBase64 = await api.extraSingleImage({
              image: base64Input,
              resize_mode: resize_mode === "dimensions" ? 1 : 0,
              upscaling_resize: scale,
              upscaling_resize_w: target_width,
              upscaling_resize_h: target_height,
              upscaling_crop: crop_to_fit,
              upscaler_1: upscaler,
              upscaler_2: second_upscaler ?? "None",
              extras_upscaler_2_visibility: second_upscaler ? second_upscaler_visibility : 0,
              gfpgan_visibility,
              codeformer_visibility,
              codeformer_weight,
              upscale_first,
            });

            const outputPath = await saveBase64Image(resultBase64, "sd_upscaled");
            const after = await imageDimensions(outputPath);
            console.error(`Upscaled image saved: ${outputPath} (${after.width}x${after.height})`);
            return outputPath;
          },
        });
      } catch (error) {
        console.error("Upscale error:", error);
        return createErrorResponse(
          `Error occurred during upscaling: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}
