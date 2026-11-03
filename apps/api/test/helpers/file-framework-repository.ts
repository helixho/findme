import path from "node:path";
import { BatchStore } from "../../src/dogfood/store.js";
import { digest } from "../../src/shared/primitives.js";
import {
  atomic,
  noLinks,
  optionalJson,
  privateDirectory,
} from "../../src/understanding-baseline/io.js";

import {
  type FrameworkRepository,
  type FrameworkState,
  FrameworkStateSchema as State,
} from "../../src/framework-runtime/schema.js";

const updateQueues = new Map<string, Promise<void>>();
export class PrivateFrameworkRepository implements FrameworkRepository {
  readonly directory: string;
  constructor(
    stateDir: string,
    readonly ownerKey: string,
  ) {
    if (!path.isAbsolute(stateDir) || !ownerKey.trim())
      throw new Error("PRIVATE_STATE_OWNER_REQUIRED");
    this.directory = path.join(stateDir, "frameworks");
  }
  private async prepare() {
    await privateDirectory(this.directory);
  }
  async read(): Promise<FrameworkState> {
    // GET is read-only; missing private state is an empty catalog, not a directory creation.
    await noLinks(path.join(this.directory, "state.json"));
    const raw = await optionalJson<{ state: unknown; hash: string }>(
      path.join(this.directory, "state.json"),
    );
    if (!raw)
      return {
        format: "u4-framework-state@1",
        owner_key: this.ownerKey,
        revision: 0,
        u4_calls_reserved: 0,
        runs: [],
        jobs: [],
        attempts: [],
        actions: [],
      };
    if (digest(raw.state) !== raw.hash) throw new Error("FRAMEWORK_STATE_INTEGRITY");
    const state = State.parse(raw.state);
    if (state.owner_key !== this.ownerKey) throw new Error("OWNER_SCOPE_MISMATCH");
    if (
      state.u4_calls_reserved !== state.attempts.length ||
      new Set(state.runs.map((r) => r.id)).size !== state.runs.length ||
      new Set(state.actions.map((a) => a.key)).size !== state.actions.length ||
      state.actions.some((a, i) => a.sequence !== i + 1) ||
      state.runs.some(
        (r) =>
          r.owner_key !== this.ownerKey ||
          r.answers.some(
            (a) => a.start !== 0 || a.end !== a.text.length || a.hash !== digest(a.text),
          ),
      )
    )
      throw new Error("FRAMEWORK_STATE_INTEGRITY");
    return state;
  }
  async update<T>(fn: (state: FrameworkState) => T | Promise<T>): Promise<T> {
    await this.prepare();
    await noLinks(path.join(this.directory, ".staging-lock"));
    const previous = updateQueues.get(this.directory) ?? Promise.resolve();
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => finished);
    updateQueues.set(this.directory, tail);
    await previous;
    try {
      return await new BatchStore(this.directory).locked(async () => {
        const state = await this.read();
        const result = await fn(state);
        state.revision++;
        State.parse(state);
        await atomic(path.join(this.directory, "state.json"), { state, hash: digest(state) });
        return result;
      });
    } finally {
      release();
      if (updateQueues.get(this.directory) === tail) updateQueues.delete(this.directory);
    }
  }
}
