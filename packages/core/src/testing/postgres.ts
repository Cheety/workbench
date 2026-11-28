import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Socket, SQL, type TCPSocketListener } from "bun";
import { z } from "zod";
import { openStatementCancellation } from "../transaction-deadline.ts";

const DEFAULT_TEST_DATABASE_URL =
	"postgres://workbench:workbench@127.0.0.1:54329/workbench_test";

export const TEST_DATABASE_URL: string =
	process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

export const SUPPORTED_POSTGRES_MAJOR = 17;

const SERVER_VERSION_NUMS_PER_MAJOR = 10000;

export class UnsupportedPostgresVersionError extends Error {
	constructor(serverVersionNum: number, major: number) {
		super(
			`test database runs Postgres ${major} (server_version_num ${serverVersionNum}), tests need Postgres ${SUPPORTED_POSTGRES_MAJOR} as in production`,
		);
		this.name = "UnsupportedPostgresVersionError";
	}
}

export function assertSupportedPostgresVersion(serverVersionNum: number): void {
	const major = Math.floor(serverVersionNum / SERVER_VERSION_NUMS_PER_MAJOR);
	if (major !== SUPPORTED_POSTGRES_MAJOR)
		throw new UnsupportedPostgresVersionError(serverVersionNum, major);
}

const serverVersionRows = z.tuple([
	z.object({ server_version_num: z.number().int() }),
]);

async function assertTestDatabaseIsSupported(): Promise<void> {
	const sql = new SQL(TEST_DATABASE_URL, { max: 1 });
	try {
		const rows =
			await sql`SELECT current_setting('server_version_num')::int AS server_version_num`;
		const [row] = serverVersionRows.parse([...rows]);
		assertSupportedPostgresVersion(row.server_version_num);
	} finally {
		await sql.close();
	}
}

function oncePerProcess(run: () => Promise<void>): () => Promise<void> {
	let result: Promise<void> | undefined;
	return () => {
		result ??= run();
		return result;
	};
}

const testDatabaseIsSupported = oncePerProcess(assertTestDatabaseIsSupported);

export class TestDatabaseWithoutTlsError extends Error {
	constructor() {
		super(
			"test database has ssl off, recreate it with: docker compose -f compose.dev.yaml up --detach --wait --force-recreate",
		);
		this.name = "TestDatabaseWithoutTlsError";
	}
}

export type TestDatabaseCertificate = {
	readonly path: string;
	remove(): Promise<void>;
};

const serverCertificateRows = z.tuple([
	z.object({ ssl: z.string(), certificate: z.string().nullable() }),
]);

export async function getTestDatabaseCertificate(): Promise<TestDatabaseCertificate> {
	const sql = new SQL(TEST_DATABASE_URL, { max: 1 });
	try {
		const rows = await sql`
			SELECT current_setting('ssl') AS ssl,
				CASE WHEN current_setting('ssl') = 'on'
					THEN pg_read_file(current_setting('ssl_cert_file')) END AS certificate`;
		const [{ certificate }] = serverCertificateRows.parse([...rows]);
		if (certificate === null) throw new TestDatabaseWithoutTlsError();
		const directory = await mkdtemp(join(tmpdir(), "workbench-test-tls-"));
		const path = join(directory, "server.crt");
		await writeFile(path, certificate);
		return {
			path,
			remove: () => rm(directory, { recursive: true, force: true }),
		};
	} finally {
		await sql.close();
	}
}

const CANCELLATION_STATEMENT_TIMEOUT_MS = 60_000;

export type FreshDatabase = {
	readonly url: string;
	readonly sql: SQL;
	readonly cancellation: SQL;
	drop(): Promise<void>;
};

export async function createFreshDatabase(): Promise<FreshDatabase> {
	await testDatabaseIsSupported();
	const name = `workbench_test_${crypto.randomUUID().replaceAll("-", "")}`;
	const admin = new SQL(TEST_DATABASE_URL, { max: 1 });
	await admin.unsafe(`CREATE DATABASE ${name}`);
	const url = new URL(TEST_DATABASE_URL);
	url.pathname = `/${name}`;
	const sql = new SQL(url.href, { max: 1 });
	const cancellation = openStatementCancellation(
		url.href,
		CANCELLATION_STATEMENT_TIMEOUT_MS,
	);
	return {
		url: url.href,
		sql,
		cancellation,
		drop: async () => {
			await cancellation.close();
			await sql.close();
			await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
			await admin.close();
		},
	};
}

type GateMode = "refusing" | "forwarding" | "silent";

type GateDirection = "requests" | "responses";

type DownstreamState = { upstream: Socket | undefined; pending: Uint8Array[] };

export class PostgresGate {
	readonly #port: number;
	readonly #target: URL;
	#listener: TCPSocketListener<DownstreamState> | undefined;
	#acceptedConnections = 0;
	readonly #held = new Set<GateDirection>();
	readonly #heldBack: (() => void)[] = [];

	private constructor(port: number, target: URL) {
		this.#port = port;
		this.#target = target;
	}

	static create(target: string = TEST_DATABASE_URL): PostgresGate {
		const reservation = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		const port = reservation.port;
		reservation.stop(true);
		return new PostgresGate(port, new URL(target));
	}

	get url(): string {
		const url = new URL(this.#target);
		url.hostname = "127.0.0.1";
		url.port = String(this.#port);
		return url.href;
	}

	get acceptedConnections(): number {
		return this.#acceptedConnections;
	}

	refuse(): void {
		this.#switchTo("refusing");
	}

	forward(): void {
		this.#switchTo("forwarding");
	}

	goSilent(): void {
		this.#switchTo("silent");
	}

	holdRequests(): void {
		this.#held.add("requests");
	}

	holdResponses(): void {
		this.#held.add("responses");
	}

	release(): void {
		this.#held.clear();
		for (const forward of this.#heldBack.splice(0)) forward();
	}

	close(): void {
		this.#switchTo("refusing");
	}

	#pass(direction: GateDirection, forward: () => void): void {
		if (this.#held.has(direction)) this.#heldBack.push(forward);
		else forward();
	}

	#switchTo(mode: GateMode): void {
		this.#listener?.stop(true);
		this.#listener = undefined;
		if (mode === "refusing") return;
		const target = {
			hostname: this.#target.hostname,
			port: Number(this.#target.port),
		};
		this.#listener = Bun.listen<DownstreamState>({
			hostname: "127.0.0.1",
			port: this.#port,
			socket: {
				open: (downstream) => {
					this.#acceptedConnections += 1;
					downstream.data = { upstream: undefined, pending: [] };
					if (mode === "silent") return;
					void Bun.connect({
						...target,
						socket: {
							open(upstream) {
								downstream.data.upstream = upstream;
								for (const chunk of downstream.data.pending)
									upstream.write(chunk);
								downstream.data.pending = [];
							},
							data: (_upstream, chunk) => {
								const bytes = new Uint8Array(chunk);
								this.#pass("responses", () => downstream.write(bytes));
							},
							close() {
								downstream.end();
							},
							error() {
								downstream.end();
							},
						},
					});
				},
				data: (downstream, chunk) => {
					const bytes = new Uint8Array(chunk);
					this.#pass("requests", () => {
						if (downstream.data.upstream) downstream.data.upstream.write(bytes);
						else downstream.data.pending.push(bytes);
					});
				},
				close(downstream) {
					downstream.data?.upstream?.end();
				},
			},
		});
	}
}
