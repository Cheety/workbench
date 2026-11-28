import type { Actor } from "@workbench/sdk";
import { isSameActor } from "./actor.ts";

export function isInstanceAdminOf(
	instanceAdmins: readonly Actor[],
): (actor: Actor) => boolean {
	return (actor) => instanceAdmins.some((admin) => isSameActor(admin, actor));
}
