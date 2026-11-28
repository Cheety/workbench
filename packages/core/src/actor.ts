import type { Actor } from "@workbench/sdk";

export function isSameActor(left: Actor, right: Actor): boolean {
	return left.kind === right.kind && left.id === right.id;
}
