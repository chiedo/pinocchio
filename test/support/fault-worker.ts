import { parentPort, workerData } from "node:worker_threads";

parentPort?.on("message", (message: { id: number }) => {
  if (workerData === "exit") process.exit(17);
  if (workerData === "error") throw new Error("INJECTED_WORKER_FAILURE");
  if (workerData === "hang") return;
  parentPort?.postMessage({ id: message.id - 1, value: "stale" });
  parentPort?.postMessage({ id: message.id, value: "current" });
});
