import { afterEach, describe, expect, test } from "bun:test";
import {
	type Actor,
	type CronJobDefinition,
	DATABASE_CAPABILITY,
	type DueCronJob,
	defineCronJob,
	defineJob,
	defineOperation,
	definePlugin,
	type EnqueuedJob,
	type JobDefinition,
} from "@workbench/sdk";
import { z } from "zod";
import { Secret } from "./config.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import { startPlugins } from "./kernel.ts";
import {
	createOperationPipeline,
	type OperationResult,
} from "./operation-pipeline.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	type MigrationRunner,
	migrateCoreSchema,
	migrateSchemas,
} from "./schema-migrations.ts";
import {
	type OperationHarness,
	type OperationHarnessOptions,
	type PluginPackage,
	startOperationHarness,
} from "./testing/operation-harness.ts";
import { createFreshDatabase } from "./testing/postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";
import { createWorkspace } from "./workspaces.ts";

const ALICE: Actor = { kind: "user", id: "alice" };

type DeliverInvoice = JobDefinition<{ invoiceId: string }>;

type DeliverInvoiceJob = EnqueuedJob<{ invoiceId: string }>;

function deliveringInvoices(run: DeliverInvoice["run"]): DeliverInvoice {
	return defineJob({
		name: "deliverInvoice",
		payload: z.object({ invoiceId: z.string() }),
		maxAttempts: 3,
		run,
	});
}

const deliverInvoiceOfAnyPayload = defineJob({
	name: "deliverInvoice",
	payload: z.unknown(),
	maxAttempts: 3,
	run: async () => {},
});

const remindOfInvoice = defineJob({
	name: "remindOfInvoice",
	payload: z.object({ invoiceId: z.string() }),
	maxAttempts: 3,
	run: async () => {},
});

const listDelivered = defineOperation({
	name: "listDelivered",
	kind: "query",
	target: "workspace",
	right: "billing.invoice.read",
	input: z.object({}),
	output: z.object({ invoiceIds: z.array(z.string()) }),
	execute: async (_input, ctx) => {
		const rows =
			await ctx.sql`SELECT invoice_id FROM delivered_invoices ORDER BY invoice_id`;
		return {
			invoiceIds: z
				.array(z.object({ invoice_id: z.string() }))
				.parse(rows)
				.map((row) => row.invoice_id),
		};
	},
});

function billing(deliverInvoice: DeliverInvoice): PluginPackage {
	const sendInvoice = defineOperation({
		name: "sendInvoice",
		kind: "mutation",
		target: "workspace",
		right: "billing.invoice.send",
		input: z.object({ amount: z.number().int() }),
		output: z.object({ id: z.string() }),
		execute: async ({ amount }, ctx) => {
			const id = ctx.newId();
			await ctx.sql`INSERT INTO invoices (id, amount) VALUES (${id}, ${amount})`;
			await ctx.enqueue(deliverInvoice, { invoiceId: id });
			if (amount < 0) throw new Error("an invoice needs a positive amount");
			return { id };
		},
	});
	const sendInvoiceWithUndeclaredJob = defineOperation({
		...sendInvoice,
		name: "sendInvoiceWithUndeclaredJob",
		execute: async (_input, ctx) => {
			const id = ctx.newId();
			await ctx.sql`INSERT INTO invoices (id, amount) VALUES (${id}, 5)`;
			await ctx.enqueue(remindOfInvoice, { invoiceId: id });
			return { id };
		},
	});
	const sendInvoiceWithMalformedJob = defineOperation({
		...sendInvoice,
		name: "sendInvoiceWithMalformedJob",
		execute: async (_input, ctx) => {
			const id = ctx.newId();
			await ctx.sql`INSERT INTO invoices (id, amount) VALUES (${id}, 5)`;
			await ctx.enqueue(deliverInvoiceOfAnyPayload, { invoiceId: 7 });
			return { id };
		},
	});
	const countInvoices = defineOperation({
		name: "countInvoices",
		kind: "query",
		target: "workspace",
		right: "billing.invoice.read",
		input: z.object({}),
		output: z.object({ invoices: z.number() }),
		execute: async (_input, ctx) => {
			const [row] =
				await ctx.sql`SELECT count(*)::int AS invoices FROM invoices`;
			return z.object({ invoices: z.number() }).parse(row);
		},
	});
	const countInvoicesAndRemind = defineOperation({
		...countInvoices,
		name: "countInvoicesAndRemind",
		execute: async (_input, ctx) => {
			await ctx.enqueue(deliverInvoice, { invoiceId: ctx.newId() });
			return { invoices: 0 };
		},
	});
	return {
		packageName: "@workbench/plugin-billing",
		pluginName: "billing",
		version: "1.0.0",
		loadDefinition: async () =>
			definePlugin({
				manifest: { name: "billing", capabilities: [DATABASE_CAPABILITY] },
				operations: [
					sendInvoice,
					sendInvoiceWithUndeclaredJob,
					sendInvoiceWithMalformedJob,
					countInvoices,
					countInvoicesAndRemind,
					listDelivered,
				],
				jobs: [deliverInvoice],
			}),
		loadMigrations: async () => [
			{
				name: "0001_create_invoices.sql",
				sql: `
					CREATE TABLE invoices (id uuid PRIMARY KEY, amount integer NOT NULL);
					CREATE TABLE delivered_invoices (invoice_id uuid PRIMARY KEY);
				`,
			},
		],
	};
}

function reports(run: CronJobDefinition["run"]): PluginPackage {
	return {
		packageName: "@workbench/plugin-reports",
		pluginName: "reports",
		version: "1.0.0",
		loadDefinition: async () =>
			definePlugin({
				manifest: { name: "reports" },
				cronJobs: [
					defineCronJob({
						name: "sendDigest",
						schedule: "*/5 * * * *",
						maxAttempts: 3,
						run,
					}),
				],
			}),
	};
}

function recordingDigests() {
	const run: DueCronJob[] = [];
	const plugin = reports(async (job) => {
		run.push(job);
	});
	return { plugin, run };
}

const ONE_MINUTE_MS = 60_000;

function recordingDeliveries() {
	const run: DeliverInvoiceJob[] = [];
	const plugin = billing(
		deliveringInvoices(async (job) => {
			run.push(job);
		}),
	);
	return { plugin, run };
}

function adjustableClock(start: string) {
	let current = new Date(start);
	return {
		now: () => current,
		advanceBy: (ms: number) => {
			current = new Date(current.getTime() + ms);
		},
	};
}

const ONE_HOUR_MS = 3_600_000;

function jobFailures(harness: OperationHarness) {
	return harness.logEntries.filter((entry) => entry.message === "job failed");
}

function deadLetters(harness: OperationHarness) {
	return harness.logEntries.filter(
		(entry) => entry.message === "job dead-lettered",
	);
}

const harnesses: OperationHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.stop();
});

async function start(
	plugins: readonly PluginPackage[],
	options: Omit<OperationHarnessOptions, "plugins"> = {},
): Promise<OperationHarness> {
	const harness = await startOperationHarness({ ...options, plugins });
	harnesses.push(harness);
	return harness;
}

function sendingInvoice(workspace: string, amount: number) {
	return calling(workspace, "billing.sendInvoice", { amount });
}

function calling(workspace: string, operation: string, input: unknown) {
	return { actor: ALICE, workspace, operation, input };
}

const sentInvoice = z.object({
	ok: z.literal(true),
	output: z.object({ id: z.string() }),
});

function invoiceIdOf(sent: OperationResult): string {
	return sentInvoice.parse(sent).output.id;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const NOT_STOPPED = new AbortController().signal;

const WORKSPACE = "00000000-0000-4000-8000-00000000aaaa";

async function startBillingPipeline(jobsCommitted: () => void) {
	const { logger } = recordingLogger();
	const database = await createFreshDatabase();
	cleanups.push(() => database.drop());
	const runner: MigrationRunner = {
		databaseUrl: new Secret(database.url),
		connectionTimeoutMs: 10_000,
		statementTimeoutMs: 60_000,
		lockRetryDelayMs: () => 0,
		setTimer: setSystemTimer,
		logger,
	};
	await migrateCoreSchema(runner, CORE_MIGRATIONS_DIRECTORY, NOT_STOPPED);
	const plugins = await startPlugins({
		discover: async () => ({
			packages: [recordingDeliveries().plugin],
			unreadable: [],
		}),
		enabledPlugins: ["billing"],
		capabilityProviders: {},
		migrateSchemas: (schemas) => migrateSchemas(runner, schemas, NOT_STOPPED),
		hookTimeout: { ms: 10_000, setTimer: setSystemTimer },
		logger,
	});
	cleanups.push(async () => {
		await plugins.deactivate();
	});
	const now = new Date("2026-11-27T09:00:00.000Z");
	await createWorkspace(database.sql, {
		id: WORKSPACE,
		name: "Alpha",
		createdAt: now,
	});
	return createOperationPipeline({
		sql: database.sql,
		registry: plugins.operations,
		events: plugins.events,
		jobs: plugins.jobs,
		now: () => now,
		newId: () => crypto.randomUUID(),
		newAuditEntryId: () => crypto.randomUUID(),
		newEventId: () => crypto.randomUUID(),
		newJobId: () => crypto.randomUUID(),
		eventsCommitted: () => {},
		jobsCommitted,
		random: () => 0.5,
		logger,
	});
}

describe("a job a mutation enqueues", () => {
	test("runs once the mutation is committed, with id, attempt, time, workspace and payload", async () => {
		const deliveries = recordingDeliveries();
		const harness = await start([deliveries.plugin]);
		const workspace = await harness.createWorkspace("Alpha");

		const sent = await harness.call(sendingInvoice(workspace, 5));
		const runBeforeTheQueueRan = [...deliveries.run];
		await harness.runJobs();

		expect(runBeforeTheQueueRan).toEqual([]);
		expect(deliveries.run).toEqual([
			{
				id: "00000000-0000-4000-b000-000000000001",
				name: "billing.deliverInvoice",
				attempt: 1,
				enqueuedAt: new Date("2026-11-26T08:00:00.000Z"),
				workspace,
				payload: { invoiceId: invoiceIdOf(sent) },
			},
		]);
		expect(harness.logEntries).toContainEqual({
			time: "2026-11-26T08:00:00.000Z",
			level: "debug",
			message: "job completed",
			jobId: "00000000-0000-4000-b000-000000000001",
			job: "billing.deliverInvoice",
			attempt: 1,
		});
	});

	test("never runs when the mutation is rolled back", async () => {
		const deliveries = recordingDeliveries();
		const harness = await start([deliveries.plugin]);
		const workspace = await harness.createWorkspace("Alpha");

		const sent = await harness.call(sendingInvoice(workspace, -5));
		await harness.runJobs();

		expect(sent).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "internal_error" }),
		});
		expect(deliveries.run).toEqual([]);
	});

	test("runs in a transaction on the schema of its plugin", async () => {
		const harness = await start([
			billing(
				deliveringInvoices(async (job, ctx) => {
					await ctx.sql`INSERT INTO delivered_invoices (invoice_id) VALUES (${job.payload.invoiceId})`;
				}),
			),
		]);
		const workspace = await harness.createWorkspace("Alpha");

		const sent = await harness.call(sendingInvoice(workspace, 5));
		await harness.runJobs();

		expect(
			await harness.call(calling(workspace, "billing.listDelivered", {})),
		).toEqual({
			ok: true,
			output: { invoiceIds: [invoiceIdOf(sent)] },
		});
	});

	test("runs once, however often the due jobs are run", async () => {
		const deliveries = recordingDeliveries();
		const harness = await start([deliveries.plugin]);
		const workspace = await harness.createWorkspace("Alpha");

		await harness.call(sendingInvoice(workspace, 5));
		await harness.call(sendingInvoice(workspace, 6));
		await harness.runJobs();
		await harness.runJobs();

		expect(deliveries.run.map((job) => job.id).sort()).toEqual([
			"00000000-0000-4000-b000-000000000001",
			"00000000-0000-4000-b000-000000000002",
		]);
	});
});

describe("a job that fails", () => {
	test("is run again with the same id after a wait that grows with each attempt, and tells the operator why it failed", async () => {
		const clock = adjustableClock("2026-11-27T09:00:00.000Z");
		const attempts: number[] = [];
		const harness = await start(
			[
				billing(
					deliveringInvoices(async (job) => {
						attempts.push(job.attempt);
						if (job.attempt <= 2) throw new Error("the mail server is down");
					}),
				),
			],
			{ now: clock.now },
		);
		const workspace = await harness.createWorkspace("Alpha");
		await harness.call(sendingInvoice(workspace, 5));

		await harness.runJobs();
		clock.advanceBy(2_499);
		await harness.runJobs();
		const attemptsBeforeTheFirstRetryIsDue = [...attempts];
		clock.advanceBy(1);
		await harness.runJobs();
		clock.advanceBy(4_999);
		await harness.runJobs();
		const attemptsBeforeTheSecondRetryIsDue = [...attempts];
		clock.advanceBy(1);
		await harness.runJobs();

		const job = "00000000-0000-4000-b000-000000000001";
		expect(attemptsBeforeTheFirstRetryIsDue).toEqual([1]);
		expect(attemptsBeforeTheSecondRetryIsDue).toEqual([1, 2]);
		expect(attempts).toEqual([1, 2, 3]);
		expect(jobFailures(harness)).toEqual([
			{
				time: "2026-11-26T08:00:00.000Z",
				level: "error",
				message: "job failed",
				jobId: job,
				job: "billing.deliverInvoice",
				attempt: 1,
				reason: "run_threw",
				error: expect.objectContaining({
					name: "Error",
					message: "the mail server is down",
				}),
				retryInMs: 2500,
			},
			expect.objectContaining({ jobId: job, attempt: 2, retryInMs: 5000 }),
		]);
		expect(deadLetters(harness)).toEqual([]);
	});

	test("is dead-lettered after its last attempt, with a log entry, and never runs again", async () => {
		const clock = adjustableClock("2026-11-27T09:00:00.000Z");
		const attempts: number[] = [];
		const harness = await start(
			[
				billing(
					deliveringInvoices(async (job) => {
						attempts.push(job.attempt);
						throw new Error("the address does not exist");
					}),
				),
			],
			{ now: clock.now },
		);
		const workspace = await harness.createWorkspace("Alpha");
		await harness.call(sendingInvoice(workspace, 5));

		await harness.runJobs();
		clock.advanceBy(ONE_HOUR_MS);
		await harness.runJobs();
		clock.advanceBy(ONE_HOUR_MS);
		await harness.runJobs();
		clock.advanceBy(ONE_HOUR_MS);
		await harness.runJobs();

		expect(attempts).toEqual([1, 2, 3]);
		expect(jobFailures(harness).map((entry) => entry.attempt)).toEqual([1, 2]);
		expect(deadLetters(harness)).toEqual([
			{
				time: "2026-11-26T08:00:00.000Z",
				level: "error",
				message: "job dead-lettered",
				jobId: "00000000-0000-4000-b000-000000000001",
				job: "billing.deliverInvoice",
				attempt: 3,
				reason: "run_threw",
				error: expect.objectContaining({
					name: "Error",
					message: "the address does not exist",
				}),
			},
		]);
	});

	test("leaves nothing behind of what the failed run wrote, and does not hold up the other jobs", async () => {
		const clock = adjustableClock("2026-11-27T09:00:00.000Z");
		let failingOnce: string | undefined;
		const harness = await start(
			[
				billing(
					deliveringInvoices(async (job, ctx) => {
						await ctx.sql`INSERT INTO delivered_invoices (invoice_id) VALUES (${job.payload.invoiceId})`;
						if (job.payload.invoiceId === failingOnce && job.attempt === 1)
							throw new Error("the mail server is down");
					}),
				),
			],
			{ now: clock.now },
		);
		const workspace = await harness.createWorkspace("Alpha");
		failingOnce = invoiceIdOf(await harness.call(sendingInvoice(workspace, 5)));
		const delivered = invoiceIdOf(
			await harness.call(sendingInvoice(workspace, 6)),
		);

		await harness.runJobs();
		const deliveredBeforeTheRetry = await harness.call(
			calling(workspace, "billing.listDelivered", {}),
		);
		clock.advanceBy(ONE_HOUR_MS);
		await harness.runJobs();

		expect(deliveredBeforeTheRetry).toEqual({
			ok: true,
			output: { invoiceIds: [delivered] },
		});
		expect(
			await harness.call(calling(workspace, "billing.listDelivered", {})),
		).toEqual({
			ok: true,
			output: { invoiceIds: [failingOnce, delivered].toSorted() },
		});
	});
});

describe("a cron job", () => {
	test("runs when its schedule falls due and not before, with the time it was due", async () => {
		const clock = adjustableClock("2026-11-27T09:00:30.000Z");
		const digests = recordingDigests();
		const harness = await start([digests.plugin], { now: clock.now });

		await harness.runJobs();
		clock.advanceBy(4 * ONE_MINUTE_MS + 29_999);
		await harness.runJobs();
		const runBeforeItWasDue = [...digests.run];
		clock.advanceBy(1);
		await harness.runJobs();

		expect(runBeforeItWasDue).toEqual([]);
		expect(digests.run).toEqual([
			{
				id: "00000000-0000-4000-b000-000000000001",
				name: "reports.sendDigest",
				attempt: 1,
				dueAt: new Date("2026-11-27T09:05:00.000Z"),
			},
		]);
	});

	test("runs once for each time it falls due, however often the due jobs are run", async () => {
		const clock = adjustableClock("2026-11-27T09:00:30.000Z");
		const digests = recordingDigests();
		const harness = await start([digests.plugin], { now: clock.now });

		await harness.runJobs();
		clock.advanceBy(5 * ONE_MINUTE_MS);
		await harness.runJobs();
		await harness.runJobs();
		clock.advanceBy(5 * ONE_MINUTE_MS);
		await harness.runJobs();
		await harness.runJobs();

		expect(digests.run.map((job) => job.dueAt)).toEqual([
			new Date("2026-11-27T09:05:00.000Z"),
			new Date("2026-11-27T09:10:00.000Z"),
		]);
	});

	test("catches up on the times it fell due since the due jobs were last run", async () => {
		const clock = adjustableClock("2026-11-27T09:00:30.000Z");
		const digests = recordingDigests();
		const harness = await start([digests.plugin], { now: clock.now });

		await harness.runJobs();
		clock.advanceBy(12 * ONE_MINUTE_MS);
		await harness.runJobs();
		await harness.runJobs();

		expect(digests.run.map((job) => job.dueAt)).toEqual([
			new Date("2026-11-27T09:05:00.000Z"),
			new Date("2026-11-27T09:10:00.000Z"),
		]);
	});

	test("is run again like any job when it fails, for the same due time", async () => {
		const clock = adjustableClock("2026-11-27T09:00:30.000Z");
		const attempts: DueCronJob[] = [];
		const harness = await start(
			[
				reports(async (job) => {
					attempts.push(job);
					if (job.attempt === 1) throw new Error("the mail server is down");
				}),
			],
			{ now: clock.now },
		);

		await harness.runJobs();
		clock.advanceBy(4 * ONE_MINUTE_MS + 30_000);
		await harness.runJobs();
		clock.advanceBy(2_500);
		await harness.runJobs();

		const dueAt = new Date("2026-11-27T09:05:00.000Z");
		expect(attempts).toEqual([
			expect.objectContaining({ attempt: 1, dueAt }),
			expect.objectContaining({ attempt: 2, dueAt }),
		]);
		expect(jobFailures(harness)).toEqual([
			expect.objectContaining({
				job: "reports.sendDigest",
				attempt: 1,
				reason: "run_threw",
				retryInMs: 2500,
			}),
		]);
	});
});

describe("a mutation that enqueues what it may not", () => {
	test.each([
		[
			"a job its plugin does not declare",
			"billing.sendInvoiceWithUndeclaredJob",
			"UndeclaredJobError",
			'"billing" enqueued the job "billing.remindOfInvoice", which it does not declare among its jobs',
		],
		[
			"a payload its job definition rejects",
			"billing.sendInvoiceWithMalformedJob",
			"InvalidJobPayloadError",
			'the payload of the job "billing.deliverInvoice" does not match its payload schema',
		],
	])(
		"is rolled back and runs nothing for %s",
		async (_case, operation, name, message) => {
			const deliveries = recordingDeliveries();
			const harness = await start([deliveries.plugin]);
			const workspace = await harness.createWorkspace("Alpha");

			const sent = await harness.call(
				calling(workspace, operation, { amount: 5 }),
			);
			await harness.runJobs();

			expect(sent).toEqual({
				ok: false,
				failure: expect.objectContaining({ code: "internal_error" }),
			});
			expect(harness.logEntries).toContainEqual(
				expect.objectContaining({
					message: "operation failed",
					reason: "execute_threw",
					error: expect.objectContaining({ name, message }),
				}),
			);
			expect(
				await harness.call(calling(workspace, "billing.countInvoices", {})),
			).toEqual({ ok: true, output: { invoices: 0 } });
			expect(deliveries.run).toEqual([]);
		},
	);
});

describe("a query", () => {
	test("fails when it enqueues a job, and runs nothing", async () => {
		const deliveries = recordingDeliveries();
		const harness = await start([deliveries.plugin]);
		const workspace = await harness.createWorkspace("Alpha");

		const counted = await harness.call(
			calling(workspace, "billing.countInvoicesAndRemind", {}),
		);
		await harness.runJobs();

		expect(counted).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "internal_error" }),
		});
		expect(harness.logEntries).toContainEqual(
			expect.objectContaining({
				message: "operation failed",
				error: expect.objectContaining({
					name: "JobEnqueuedByQueryError",
					message:
						'the query "billing.countInvoicesAndRemind" enqueued a job; only a mutation enqueues jobs',
				}),
			}),
		);
		expect(deliveries.run).toEqual([]);
	});
});

describe("the pipeline", () => {
	test.each([
		["once after a mutation that enqueued a job", "billing.sendInvoice", 5, 1],
		["not after a mutation that was rolled back", "billing.sendInvoice", -5, 0],
		["not after a query", "billing.countInvoices", 5, 0],
	])(
		"tells the job queue that jobs were committed %s",
		async (_case, operation, amount, expected) => {
			let told = 0;
			const pipeline = await startBillingPipeline(() => {
				told += 1;
			});

			await pipeline.invoke({
				operation,
				actor: ALICE,
				apiTokenId: null,
				workspace: WORKSPACE,
				input: { amount },
				correlationId: "request-1",
			});

			expect(told).toBe(expected);
		},
	);
});
