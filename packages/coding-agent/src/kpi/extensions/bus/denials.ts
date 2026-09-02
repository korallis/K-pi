import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

/** Why the bus refused. Codes, so a grader can match without parsing prose. */
export type BusDenialReason = "worker-limit" | "writer-live" | "admission-held" | "claim-held" | "role-tool";

export interface BusDenial {
	reason: BusDenialReason;
	role?: string;
	agent_id?: string;
	/** Canonical claim key, for a refused path claim. */
	key?: string;
	/** The agent already holding what was refused. */
	holder?: string;
	limit?: number;
}

/**
 * Appends one refusal to the bus transcript.
 *
 * Workers record here rather than into the job's hash-chained log: that chain is
 * check-then-act under a single process's lock, so a second process appending to
 * it would produce two records claiming one predecessor. `bus.jsonl` is an
 * append-and-fsync transcript with no chain, which is exactly what a second
 * process may safely add to. Parent-side refusals reach both.
 *
 * A capability id is never included. It is the bearer that would have authorised
 * the work, and a refusal is the last place to publish one.
 */
export async function appendBusDenial(runDirectory: string, jobId: string, denial: BusDenial): Promise<void> {
	await mkdir(runDirectory, { recursive: true });
	const record = { ts: new Date().toISOString(), type: "agent.denied", job_id: jobId, ...denial };
	const file = await open(join(runDirectory, "bus.jsonl"), "a", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(record)}\n`);
		await file.sync();
	} finally {
		await file.close();
	}
}
