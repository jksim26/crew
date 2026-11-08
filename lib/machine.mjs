// Which machine runs which issue. crew.json names a main runner and helpers; each machine learns its
// own name once (`crew machine set pc`, stored machine-locally). An issue labelled with a machine
// name runs only there; an unlabelled issue runs on the main machine.
import { machineNames } from "./config.mjs";
import { readLocal, saveLocal } from "./secrets.mjs";

export const MACHINE_KEY = "CREW_MACHINE";

export function thisMachine(env = process.env, platform = process.platform) {
  const v = readLocal(MACHINE_KEY, env, platform);
  return v ? v.trim().toLowerCase() : null;
}

export function setMachine(config, name, opts = {}) {
  const n = String(name ?? "").trim().toLowerCase();
  const names = machineNames(config);
  if (names.length && !names.includes(n)) throw new Error(`"${n}" is not in crew.json machines (${names.join(", ")})`);
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(n)) throw new Error("a machine name is short and lowercase, like pc or mac");
  return saveLocal(MACHINE_KEY, n, opts);
}

/** null when this machine may take an issue with these labels, else the reason it may not. */
export function routeIssue(config, labels, me) {
  const names = machineNames(config);
  if (!names.length) return null;
  if (!me) return `this machine has no crew name (run: crew machine set <${names.join("|")}>)`;
  if (!names.includes(me)) return `this machine is "${me}", which crew.json machines does not list`;
  const tagged = labels.filter((l) => names.includes(l));
  if (tagged.length) return tagged.includes(me) ? null : `for ${tagged.join("/")}, this is ${me}`;
  return me === config.machines.main ? null : `unlabelled work runs on ${config.machines.main} (label it ${me} to run here)`;
}
