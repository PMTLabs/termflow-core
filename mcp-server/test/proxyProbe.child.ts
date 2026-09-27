// Driven by apiClient.test.ts in a child process with HTTP_PROXY pointing at a dead port
// and no NO_PROXY. Prints one line per probe; exits non-zero if either is wrong.
import axios from "axios";
import { createApiClient } from "../src/apiClient";

const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
const baseURL = `http://127.0.0.1:${server.port}`;
let failed = false;
try {
    // Control: a default client must be diverted to the (dead) proxy, otherwise the
    // assertion below would pass vacuously.
    try {
        await axios.get("/health", { baseURL, timeout: 1500 });
        console.log("control: direct (HTTP_PROXY not honoured — control is inert)");
        failed = true;
    } catch {
        console.log("control: proxied");
    }

    try {
        const response = await createApiClient({ baseURL, timeout: 1500 }).get("/health");
        console.log(response.data?.ok === true ? "client: direct" : "client: unexpected body");
        failed ||= response.data?.ok !== true;
    } catch (e: any) {
        console.log(`client: proxied (${e.code})`);
        failed = true;
    }
} finally {
    server.stop(true);
}
process.exit(failed ? 1 : 0);
