import { fileURLToPath } from "node:url";
import { describeHttpApi, OPENAPI_DOCUMENT_PATH } from "./openapi.ts";
import { discoverPluginPackages } from "./plugin-discovery.ts";

const PACKAGES_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));

const { packages } = await discoverPluginPackages(PACKAGES_DIRECTORY)();
await Bun.write(
	OPENAPI_DOCUMENT_PATH,
	JSON.stringify(await describeHttpApi(packages)),
);
