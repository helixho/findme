// A real independent Node process. Only the generated directory passed by the test is used.
import { BatchStore } from "../../src/dogfood/store.js";
import { PrivateFrameworkRepository } from "./file-framework-repository.js";

const [kind, directory, operation] = process.argv.slice(2);
const watchdog = setTimeout(() => process.exit(70), 10_000);
const release = () => new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
try {
  if (operation === "unrelated") {
    const released = release();
    console.log("READY");
    await released;
  } else {
    const mutate = async (state: { version?: number; revision?: number }) => {
      if (kind === "batch") state.version = (state.version ?? 0) + 10;
      else state.revision = (state.revision ?? 0) + 10;
      if (operation === "fail") throw new Error("SYNTHETIC_TRANSACTION_FAILURE");
      if (operation === "hold") {
        const released = release();
        console.log("READY");
        await released;
      }
    };
    if (kind === "batch") await new BatchStore(directory).update((batch) => mutate(batch.state));
    else await new PrivateFrameworkRepository(directory, "synthetic-owner").update(mutate);
    console.log("COMMITTED");
  }
} catch (error) {
  console.log(`ERROR:${(error as Error).message}`);
  process.exitCode = 2;
} finally {
  clearTimeout(watchdog);
  process.stdin.destroy();
}
