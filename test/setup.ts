import { setupNetwork } from "@msw/cloudflare";
import { afterAll, afterEach, beforeAll } from "vitest";

/**
 * Outbound requests are mocked so the tests never touch the real internet.
 * Handlers are registered per test with `network.use(...)`.
 */
export const network = setupNetwork();

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
