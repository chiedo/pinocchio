import { parentPort, workerData } from "node:worker_threads";

if (workerData === "cold-start") await new Promise((resolve) => setTimeout(resolve, 1_200));

parentPort?.on("message", (message: { id: number; payload?: { action?: string } }) => {
  if (workerData === "exit") process.exit(17);
  if (workerData === "error") throw new Error("INJECTED_WORKER_FAILURE");
  if (workerData === "hang") return;
  if (workerData === "cold-start" && message.payload?.action === "health") {
    parentPort?.postMessage({ id: message.id, value: { status: "ready", protocol: 1 } });
    return;
  }
  parentPort?.postMessage({ id: message.id - 1, value: "stale" });
  parentPort?.postMessage({ id: message.id, value: "current" });
});
