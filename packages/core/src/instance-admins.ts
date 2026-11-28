import type { Actor } from "@workbench/sdk";

export function instanceAdminCheck(
	instanceAdmins: readonly Actor[],
): (actor: Actor) => boolean {
	return (actor) =>
		instanceAdmins.some(
			(admin) => admin.kind === actor.kind && admin.id === actor.id,
		);
}
