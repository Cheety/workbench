import type { ThrownError } from "./failure-reason.ts";
import type { Logger } from "./logger.ts";

export type LoadFailureReason =
	| "invalid_manifest"
	| "load_timed_out"
	| "unknown_plugin"
	| "duplicate_plugin"
	| "missing_dependency"
	| "version_mismatch"
	| "dependency_not_loaded"
	| "dependency_cycle"
	| "capability_unavailable"
	| "activation_failed"
	| "activation_timed_out";

export type LoadFailure = {
	readonly plugin: string;
	readonly reason: LoadFailureReason;
	readonly detail: string;
	readonly error?: ThrownError;
};

export class LoadFailures {
	readonly #logger: Logger;
	readonly #failures: LoadFailure[] = [];

	constructor(logger: Logger) {
		this.#logger = logger;
	}

	reject(failure: LoadFailure): void {
		this.#failures.push(failure);
		this.#logger.error("plugin not loaded", failure);
	}

	find(plugin: string): LoadFailure | undefined {
		return this.#failures.find((failure) => failure.plugin === plugin);
	}

	get all(): readonly LoadFailure[] {
		return this.#failures;
	}
}
