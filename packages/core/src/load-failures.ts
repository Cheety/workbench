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
	| "activation_failed"
	| "activation_timed_out";

/** Why a plugin was not loaded, worded for the operator of the instance. */
export type LoadFailure = {
	/** The plugin name, as the instance config or a manifest refers to it. */
	readonly plugin: string;
	readonly reason: LoadFailureReason;
	readonly detail: string;
	/** What the plugin threw, if that is why it was not loaded. */
	readonly error?: ThrownError;
};

/** Collects the load failures of one instance start and logs each once. */
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
