// src/tools/job-response.ts
//
// Runs a long image operation as a tracked job.
//
// By default the tool simply waits for the image and returns it inline, which
// is what a client with a reasonable request deadline wants. The job registry
// underneath exists so that a render is never *lost*: if the wait window
// elapses — or the client stops listening first — the work keeps running in
// this process and check-generation collects the result later.
//
// While waiting we also emit MCP progress notifications when the client asked
// for them. Those do not extend a client's hard request deadline, but they do
// reset the *idle* timeout that some clients apply, and they surface the
// percentage in clients that display it.

import { StableDiffusionAPI } from "../api/sd-api.js";
import { SD_API_URL } from "../config.js";
import { Job, startJob, waitForJob, describeElapsed } from "../jobs.js";
import { imageToResponseBase64, createImageResponse } from "../utils/image-io.js";

const api = new StableDiffusionAPI(SD_API_URL);

/** The parts of the MCP request context this module uses, kept loose on purpose. */
export interface ProgressContext {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
}

const POLL_INTERVAL_MS = 2000;

/**
 * Poll the WebUI for progress and forward it to the client until `stop` fires.
 * Best-effort throughout: a failed poll or a client that rejects the
 * notification must never disturb the generation itself.
 */
function streamProgress(context: ProgressContext | undefined, stop: AbortSignal): void {
  const token = context?._meta?.progressToken;
  const send = context?.sendNotification;
  if (token === undefined || !send) return;

  const tick = async () => {
    if (stop.aborted) return;
    try {
      const progress = await api.getProgress();
      if (stop.aborted) return;
      await send({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: Math.round((progress.progress ?? 0) * 100),
          total: 100,
          message:
            progress.state?.sampling_steps > 0
              ? `step ${progress.state.sampling_step}/${progress.state.sampling_steps}`
              : "generating",
        },
      });
    } catch {
      // Progress is a nicety; never let it interfere.
    }
  };

  const timer = setInterval(tick, POLL_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  stop.addEventListener("abort", () => clearInterval(timer), { once: true });
}

/** Build the tool result for a job that has finished successfully. */
export async function deliverJob(job: Job, headline: string): Promise<any> {
  job.delivered = true;
  const responseImage = await imageToResponseBase64(job.imagePath!);
  return createImageResponse(
    `${headline}\n\nTook ${describeElapsed(job)}\nImage path: ${job.imagePath}`,
    responseImage.data,
    responseImage.mimeType
  );
}

export interface RunAsJobOptions {
  kind: Job["kind"];
  /** Short label shown when listing jobs. */
  label: string;
  /** Text prepended to the result when the image comes back inline. */
  headline: string;
  /** Extra detail lines appended to the headline (LoRAs applied, and so on). */
  details?: string;
  waitSeconds: number;
  context?: ProgressContext;
  work: () => Promise<string>;
}

/**
 * Run `work` as a tracked job, waiting up to `waitSeconds` for it to finish.
 */
export async function runAsJob(options: RunAsJobOptions): Promise<any> {
  const job = startJob(options.kind, options.label, options.work);

  const stop = new AbortController();
  streamProgress(options.context, stop.signal);
  try {
    await waitForJob(job, Math.max(1, options.waitSeconds) * 1000);
  } finally {
    stop.abort();
  }

  if (job.status === "done") {
    return await deliverJob(job, `${options.headline}${options.details ?? ""}`);
  }

  if (job.status === "error") {
    job.delivered = true;
    return {
      content: [{ type: "text", text: `Generation failed after ${describeElapsed(job)}.\n\n${job.error}` }],
    };
  }

  // Still running. Report where it is and hand back the id.
  let progressLine = "";
  try {
    const progress = await api.getProgress();
    const percent = Math.round((progress.progress ?? 0) * 100);
    const eta = Math.round(progress.eta_relative ?? 0);
    progressLine =
      `\nProgress: ${percent}%` +
      (progress.state?.sampling_steps
        ? ` (step ${progress.state.sampling_step}/${progress.state.sampling_steps})`
        : "") +
      (eta > 0 ? `, roughly ${eta}s remaining` : "");
  } catch {
    /* progress is optional */
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Still rendering after ${options.waitSeconds}s, so here is a job id rather than a longer ` +
          `wait. The image is still being generated and will be saved when it finishes — ` +
          `nothing is lost.\n\n` +
          `Job id: ${job.id}${options.details ?? ""}${progressLine}\n\n` +
          `Call check-generation to collect it (with no arguments it picks this job up automatically).`,
      },
    ],
  };
}
