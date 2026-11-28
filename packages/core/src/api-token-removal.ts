import { defineCronJob } from "@workbench/sdk";

const RETENTION_MS = 30 * 86_400_000;

const MOST_REMOVED_PER_RUN = 1000;

export const removeRevokedAndExpiredApiTokens = defineCronJob({
	name: "removeRevokedAndExpiredApiTokens",
	schedule: "0 * * * *",
	maxAttempts: 3,
	run: async (_job, ctx) => {
		const settledBy = new Date(ctx.now().getTime() - RETENTION_MS);
		await ctx.sql`
			DELETE FROM core.api_tokens
			WHERE id IN (
				SELECT id FROM core.api_tokens settled
				WHERE (expires_at <= ${settledBy} OR revoked_at <= ${settledBy})
					AND NOT EXISTS (
						SELECT FROM core.api_tokens created
						WHERE created.created_by_api_token_id = settled.id
					)
				LIMIT ${MOST_REMOVED_PER_RUN}
				FOR UPDATE SKIP LOCKED
			)`;
	},
});
