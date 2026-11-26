import type { Logger } from "./logger.ts";

export type LoadFailureReason =
	| "invalid_manifest"
	| "unknown_plugin"
	| "missing_dependency"
	| "version_mismatch"
	| "dependency_not_loaded"
	| "dependency_cycle"
	| "activation_failed";

/** Why a plugin was not loaded, worded for the operator of the instance. */
export type LoadFailure = {
	/** The plugin name, or the plugin package name if the name is unusable. */
	readonly plugin: string;
	readonly reason: LoadFailureReason;
	readonly detail: string;
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
