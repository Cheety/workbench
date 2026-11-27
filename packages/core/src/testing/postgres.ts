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

type DownstreamState = { upstream: Socket | undefined; pending: Uint8Array[] };

export class PostgresGate {
	readonly #port: number;
	readonly #target: URL;
	#listener: TCPSocketListener<DownstreamState> | undefined;
	#acceptedConnections = 0;

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

	close(): void {
		this.#switchTo("refusing");
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
							data(_upstream, chunk) {
								downstream.write(chunk);
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
				data(downstream, chunk) {
					if (downstream.data.upstream) downstream.data.upstream.write(chunk);
					else downstream.data.pending.push(new Uint8Array(chunk));
				},
				close(downstream) {
					downstream.data?.upstream?.end();
				},
			},
		});
	}
}
