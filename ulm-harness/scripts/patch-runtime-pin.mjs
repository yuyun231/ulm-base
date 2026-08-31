#!/usr/bin/env node
// Adds (or updates) a throwaway `ulm-spike` agent whose model-scoped
// agentRuntime.id pins the OpenClaw turn to the `ulm-harness-spike` harness.
//
// This script intentionally only touches the `ulm-spike` agent entry.
// It creates a timestamped backup of openclaw.json before writing.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODEL_REF = process.env.ULM_SPIKE_MODEL || "stepfun/step-3.7-flash";
const HARNESS_ID = "ulm-harness-spike";
const AGENT_ID = "ulm-spike";

const configPath = join(homedir(), ".openclaw", "openclaw.json");

if (!existsSync(configPath)) {
  console.error(`config not found: ${configPath}`);
  process.exit(1);
}

const raw = readFileSync(configPath, "utf-8");
const cfg = JSON.parse(raw);
const backupPath = `${configPath}.bak-${Date.now()}`;
writeFileSync(backupPath, raw, "utf-8");
console.log(`backup written: ${backupPath}`);

cfg.agents ??= {};
cfg.agents.list ??= [];

let entry = cfg.agents.list.find((a) => a.id === AGENT_ID);
if (!entry) {
  entry = { id: AGENT_ID };
  cfg.agents.list.push(entry);
}

entry.name ??= "ULM Spike";
entry.model = MODEL_REF;
entry.models ??= {};
entry.models[MODEL_REF] ??= {};
entry.models[MODEL_REF].agentRuntime = { id: HARNESS_ID };

writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
console.log(`patched agent ${AGENT_ID}: model=${MODEL_REF} agentRuntime=${HARNESS_ID}`);
console.log("next: restart openclaw gateway, then run:");
console.log(`  openclaw agent --agent ${AGENT_ID} --message "spike ping" --json`);
