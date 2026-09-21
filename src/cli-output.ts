import { isRecord } from "./identity.js";

export function cliInvocation(args: string[]) {
  return {
    args: args.filter((arg) => arg !== "--json"),
    json: args.includes("--json"),
  };
}

function label(key: string) {
  const normalized = key === key.toUpperCase() ? key.toLowerCase() : key;
  return normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function scalar(value: unknown, key = "") {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (key.toLowerCase().includes("bytes")) {
      return new Intl.NumberFormat("en-US", { style: "unit", unit: "megabyte", maximumFractionDigits: 1 })
        .format(value / 1_000_000);
    }
    return value.toLocaleString("en-US");
  }
  return String(value);
}

function primary(record: Record<string, unknown>) {
  for (const key of ["agent", "name", "id", "bindingId", "runId", "recordId", "status"]) {
    if (typeof record[key] === "string") return { key, value: record[key] };
  }
  return undefined;
}

function renderArray(key: string, values: unknown[], indent: string) {
  if (!values.length) return [`${indent}${label(key)}: None`];
  if (!values.every(isRecord)) {
    return [`${indent}${label(key)}: ${values.map((value) => scalar(value)).join(", ")}`];
  }
  const records = values as Record<string, unknown>[];
  if (key === "agents") {
    const statuses = new Map<string, number>();
    let vectors = 0;
    for (const record of records) {
      const status = typeof record.status === "string" ? record.status : "unknown";
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      if (typeof record.vectors === "number") vectors += record.vectors;
    }
    const summary = [...statuses].map(([status, count]) => `${count} ${status}`).join(", ");
    const lines = [`${indent}Agents: ${summary}${vectors ? `; ${vectors.toLocaleString("en-US")} vectors` : ""}`];
    const models = new Set(records.map((record) => record.model).filter((value): value is string => typeof value === "string"));
    if (models.size === 1) lines.push(`${indent}Model: ${[...models][0]}`);
    for (const record of records) {
      const heading = primary(record);
      const details = Object.entries(record)
        .filter(([field, value]) => field !== heading?.key && field !== "model" &&
          !(heading && ["agent", "name"].includes(heading.key) && field === "bindingId") && value !== undefined &&
          (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
        .map(([field, value]) => field === "vectors" ? `${scalar(value)} vectors` :
          field === "status" || field === "mode" ? scalar(value) : `${label(field)}: ${scalar(value, field)}`);
      lines.push(`${indent}- ${heading ? scalar(heading.value) : "Agent"}${details.length ? `: ${details.join(", ")}` : ""}`);
    }
    return lines;
  }
  const lines = [`${indent}${label(key)} (${records.length}):`];
  for (const record of records) {
    const heading = primary(record);
    lines.push(`${indent}  - ${heading ? scalar(heading.value) : "Item"}`);
    for (const [field, value] of Object.entries(record)) {
      if (field === heading?.key || value === undefined) continue;
      lines.push(...renderField(field, value, `${indent}    `));
    }
  }
  return lines;
}

function renderField(key: string, value: unknown, indent = ""): string[] {
  if (Array.isArray(value)) return renderArray(key, value, indent);
  if (isRecord(value)) {
    const lines = [`${indent}${label(key)}:`];
    for (const [field, nested] of Object.entries(value)) {
      if (nested !== undefined) lines.push(...renderField(field, nested, `${indent}  `));
    }
    return lines;
  }
  return [`${indent}${label(key)}: ${scalar(value, key)}`];
}

export function formatCliResult(result: unknown) {
  if (!isRecord(result)) return `${scalar(result)}\n`;
  const lines: string[] = [];
  if (typeof result.status === "string") lines.push(`Status: ${label(result.status)}`);
  for (const [key, value] of Object.entries(result)) {
    if (key !== "status" && value !== undefined) lines.push(...renderField(key, value));
  }
  return `${lines.join("\n")}\n`;
}

const ERROR_MESSAGES: Record<string, string> = {
  AGENT_NOT_INSTALLED: "The requested agent is not installed.",
  COPILOT_NOT_AVAILABLE: "GitHub Copilot CLI is not installed or could not be started.",
  EXPLICIT_BINDING_REQUIRED: "Provide both --binding and --fingerprint.",
  EXPLICIT_CONFIRMATION_REQUIRED: "This command requires the --confirm flag.",
  EXPLICIT_NAME_AND_SCOPE_REQUIRED: "Provide a valid --name and exactly one repository or global scope.",
  INVALID_ARGUMENTS: "The command or one of its options is invalid.",
  INVALID_BINDING: "The binding command or binding reference is invalid.",
  INVALID_INPUT: "The supplied input is missing or invalid.",
  NO_ENROLLED_AGENTS: "No enrolled Pinocchio agents were found.",
  NODE_22_18_OR_NEWER_22_REQUIRED: "Pinocchio requires Node.js 22.18 or newer in the Node.js 22 release line.",
};

export interface CliErrorOutput {
  code: string;
  message?: string;
  repair?: string;
  details?: Record<string, unknown>;
}

export function formatCliError(error: CliErrorOutput) {
  const message = error.message ?? ERROR_MESSAGES[error.code] ?? label(error.code).replace(/\.$/, "") + ".";
  const lines = [`Error: ${message}`, `Code: ${error.code}`];
  for (const [key, value] of Object.entries(error.details ?? {})) {
    if (value !== undefined) lines.push(...renderField(key, value));
  }
  if (error.repair) lines.push(`How to fix: ${error.repair}`);
  return `${lines.join("\n")}\n`;
}

export function serializedCliResult(result: unknown, json: boolean) {
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatCliResult(result);
}

export function serializedCliError(error: CliErrorOutput, json: boolean) {
  const output = { status: "error", code: error.code, ...(error.message ? { message: error.message } : {}),
    ...(error.repair ? { repair: error.repair } : {}), ...error.details };
  return json ? `${JSON.stringify(output, null, 2)}\n` : formatCliError(error);
}

export function writeCliResult(result: unknown, json: boolean) {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(serializedCliResult(result, json), (error) => error ? reject(error) : resolve());
  });
}

export function writeCliError(error: CliErrorOutput, json: boolean) {
  process.stderr.write(serializedCliError(error, json));
}
