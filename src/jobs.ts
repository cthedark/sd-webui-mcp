// src/jobs.ts
//
// A registry of in-flight generations, so a render is never lost.
//
// A generation can legitimately run for minutes. Two things can cut the tool
// call short before it finishes: the configured wait window elapsing, or the
// MCP client hitting its own request deadline — one the server can neither see
// nor change (the MCP TypeScript SDK defaults to 60s, and not every host
// exposes a setting for it). In either case the WebUI keeps rendering; without
// somewhere to put the result, the finished image would simply be discarded.
//
// So generation tools register their work here. The tool waits for it in the
// normal case and returns the image inline; if the wait ends first it hands
// back a job id. Either way the work continues in this process, the result is
// held, and check-generation collects it.

import { randomUUID } from "crypto";

export type JobStatus = "running" | "done" | "error";

export interface Job {
  id: string;
  kind: "txt2img" | "img2img" | "upscale";
  /** Short human label, e.g. the prompt, for disambiguating jobs. */
  label: string;
  startedAt: number;
  finishedAt?: number;
  status: JobStatus;
  /** Path of the finished image, once status is "done". */
  imagePath?: string;
  /** Failure message, once status is "error". */
  error?: string;
  /** Set when the result has already been handed to the caller. */
  delivered: boolean;
  promise: Promise<string>;
}

const jobs = new Map<string, Job>();

/** Jobs are dropped this long after finishing, so the map cannot grow forever. */
const RETENTION_MS = 60 * 60 * 1000;

function evictOld(): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && job.finishedAt < cutoff) {
      jobs.delete(id);
    }
  }
}

/**
 * Register work that produces a saved image path. The promise is consumed here
 * immediately so a later failure can never surface as an unhandled rejection,
 * whether or not anyone ever collects the result.
 */
export function startJob(kind: Job["kind"], label: string, work: () => Promise<string>): Job {
  evictOld();

  const id = `${kind}-${randomUUID().slice(0, 8)}`;
  const promise = work();

  const job: Job = {
    id,
    kind,
    label,
    startedAt: Date.now(),
    status: "running",
    delivered: false,
    promise,
  };

  promise.then(
    imagePath => {
      job.status = "done";
      job.imagePath = imagePath;
      job.finishedAt = Date.now();
      console.error(`Job ${id} finished: ${imagePath}`);
    },
    error => {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = Date.now();
      console.error(`Job ${id} failed: ${job.error}`);
    }
  );

  jobs.set(id, job);
  return job;
}

/**
 * Wait up to `ms` for a job to finish. Resolves either way — the caller
 * inspects job.status rather than catching, so a failure inside the bounded
 * wait is reported as a normal tool result.
 */
export function waitForJob(job: Job, ms: number): Promise<void> {
  if (job.status !== "running") return Promise.resolve();

  return new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    // Do not keep the process alive purely for this timer.
    if (typeof timer.unref === "function") timer.unref();

    job.promise.then(finish, finish);
  });
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/** All jobs, newest first. */
export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * The job a bare check-generation should report on: the oldest undelivered
 * finished job if there is one (so results are collected in order), otherwise
 * the most recently started job.
 */
export function pickDefaultJob(): Job | undefined {
  const all = listJobs();
  const undelivered = all.filter(j => j.status !== "running" && !j.delivered);
  if (undelivered.length) return undelivered[undelivered.length - 1];
  return all[0];
}

export function runningJobs(): Job[] {
  return listJobs().filter(j => j.status === "running");
}

export function describeElapsed(job: Job): string {
  const ms = (job.finishedAt ?? Date.now()) - job.startedAt;
  return `${Math.round(ms / 1000)}s`;
}
