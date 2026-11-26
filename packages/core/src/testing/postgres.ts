import type { Socket, TCPSocketListener } from "bun";

const DEFAULT_TEST_DATABASE_URL =
	"postgres://workbench:workbench@127.0.0.1:54329/workbench_test";

export const TEST_DATABASE_URL: string =
	process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

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

	static create(): PostgresGate {
		const reservation = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		const port = reservation.port;
		reservation.stop(true);
		return new PostgresGate(port, new URL(TEST_DATABASE_URL));
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
