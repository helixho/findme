import path from "node:path";
import { fileURLToPath } from "node:url";
import { LayersRunner } from "../src/dogfood/layers.js";
import { outsideRepo } from "../src/dogfood/store.js";
const args = process.argv.slice(2);
const batch = args[0];
if (!batch || args[1] !== "--live")
  throw new Error("Usage: av-layers <absolute-frozen-batch> --live");
const root = await outsideRepo(batch, fileURLToPath(new URL("../../../", import.meta.url)));
await new LayersRunner(path.resolve(root)).execute();
