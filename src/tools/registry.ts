/**
 * Single place that knows every tool and what it does to the family's data.
 *
 * Each tool is classified by effect. The registry turns that into MCP tool
 * annotations (so clients can show read-only vs destructive before calling)
 * and lets a deployment exclude whole classes: the hosted server for Claude
 * Duet, for example, registers no destructive tools.
 *
 * A tool that is not classified here fails registration loudly, so a new tool
 * cannot ship unlabelled.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { registerCalendarTools } from "./calendar.js";
import { registerChoreTools } from "./chores.js";
import { registerFamilyTools } from "./family.js";
import { registerListTools } from "./lists.js";
import { registerMealTools } from "./meals.js";
import { registerMessageTools } from "./messages.js";
import { registerMiscTools } from "./misc.js";
import { registerPhotoTools } from "./photos.js";
import { registerLabelTools } from "./labels.js";
import { registerPlanningTools } from "./planning.js";
import { registerRewardTools } from "./rewards.js";
import { registerTaskTools } from "./tasks.js";
import { getDefaultWriteGuard, logWrite, refusalResult, type WriteGuardLike } from "../utils/write-guard.js";

/**
 * read: no change to Skylight data.
 * write: creates or updates; reversible by another edit.
 * destructive: deletes or otherwise cannot be undone from the API.
 */
export type ToolEffect = "read" | "write" | "destructive";

export const TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = {
  // calendar
  get_calendar_events: "read",
  get_source_calendars: "read",
  delete_source_calendar: "destructive",
  update_source_calendar_profiles: "write",
  rename_source_calendar: "write",
  create_calendar_event: "write",
  update_calendar_event: "write",
  delete_calendar_event: "destructive",
  // chores
  get_chores: "read",
  create_chore: "write",
  update_chore: "write",
  complete_chore: "write",
  create_routine: "write",
  delete_chore: "destructive",
  // lists
  get_lists: "read",
  get_list_items: "read",
  create_list: "write",
  update_list: "write",
  create_list_item: "write",
  update_list_item: "write",
  delete_list: "destructive",
  delete_list_item: "destructive",
  // tasks
  get_task_box: "read",
  create_task: "write",
  delete_task_box_item: "destructive",
  // family / misc
  get_family_members: "read",
  get_avatars: "read",
  get_colors: "read",
  get_frame_info: "read",
  get_devices: "read",
  get_labels: "read",
  delete_label: "destructive",
  // rewards (Plus)
  get_rewards: "read",
  get_reward_points: "read",
  create_reward: "write",
  update_reward: "write",
  redeem_reward: "write",
  unredeem_reward: "write",
  delete_reward: "destructive",
  // meals (Plus)
  get_meal_categories: "read",
  get_meal_sittings: "read",
  get_recipes: "read",
  get_recipe: "read",
  create_meal_sitting: "write",
  update_meal_sitting: "write",
  delete_meal_sitting: "destructive",
  create_recipe: "write",
  update_recipe: "write",
  add_recipe_to_grocery_list: "write",
  delete_recipe: "destructive",
  // photos (Plus)
  get_albums: "read",
  // planning (composite)
  get_week_overview: "read",
  find_conflicts: "read",
  find_free_slots: "read",
  plan_week_meals: "write",
  // messages (frame "nudges")
  get_messages: "read",
  send_message: "write",
  update_message: "write",
  delete_message: "destructive",
};

export interface RegisterToolsOptions {
  /** Whether the account has Skylight Plus; gates rewards, meals and photos. */
  hasPlus: boolean;
  /** Effects to register. Default: all. */
  effects?: readonly ToolEffect[];
  /** Individual tools to register even if their effect class is excluded. Least-privilege exceptions. */
  include?: readonly string[];
  /** Register the photo tools (uploads). Default: true when hasPlus. */
  photos?: boolean;
  /** Rate backstop for non-read tools. Default: the process-wide guard. Tests pass their own. */
  writeGuard?: WriteGuardLike;
}

export function annotationsFor(effect: ToolEffect): ToolAnnotations {
  return {
    readOnlyHint: effect === "read",
    destructiveHint: effect === "destructive",
    idempotentHint: effect !== "write",
    openWorldHint: false,
  };
}

/** Names of the tools that would be registered with these options. */
export function selectedTools(options: RegisterToolsOptions): string[] {
  const effects = new Set(options.effects ?? ["read", "write", "destructive"]);
  const include = new Set(options.include ?? []);
  return Object.entries(TOOL_EFFECTS)
    .filter(([name, effect]) => effects.has(effect) || include.has(name))
    .map(([name]) => name);
}

type ToolCallback = (...args: unknown[]) => unknown;

/**
 * Wrap a non-read tool so each call is rate-checked and logged (see
 * utils/write-guard.ts). Read tools are returned untouched. A refusal returns an
 * MCP error result without calling the tool, so nothing is changed.
 */
function guardedCallback(name: string, effect: ToolEffect, callback: unknown, guard: WriteGuardLike): unknown {
  if (effect === "read") return callback;
  const inner = callback as ToolCallback;
  return async (...args: unknown[]) => {
    const verdict = await guard.admit(effect);
    if (!verdict.ok) {
      logWrite(name, effect, verdict.limiterError ? "limiter_error" : "refused", verdict.recent, guard.kind);
      return refusalResult(verdict.reason, verdict.retryAfterSeconds, verdict.limiterError === true);
    }
    try {
      const result = await inner(...args);
      const failed = typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
      logWrite(name, effect, failed ? "tool_error" : "ok", verdict.recent, guard.kind);
      return result;
    } catch (error) {
      logWrite(name, effect, "threw", verdict.recent, guard.kind);
      throw error;
    }
  };
}

/**
 * Register the Skylight tools on `server`, filtered by effect, with MCP
 * annotations derived from the classification above.
 */
export function registerTools(server: McpServer, options: RegisterToolsOptions): string[] {
  const allowed = new Set(selectedTools(options));
  const registered: string[] = [];
  const guard = options.writeGuard ?? getDefaultWriteGuard();

  // Intercept server.tool() so the per-domain register functions stay as they
  // are: the registry decides what gets through and attaches annotations.
  const filtered: McpServer = Object.create(server);
  filtered.tool = ((name: string, ...rest: unknown[]) => {
    const effect = TOOL_EFFECTS[name];
    if (!effect) {
      throw new Error(`Tool "${name}" is not classified in TOOL_EFFECTS; add it with its effect.`);
    }
    if (!allowed.has(name)) {
      return undefined as never;
    }
    registered.push(name);
    const callback = guardedCallback(name, effect, rest.pop(), guard);
    // Insert annotations before the callback: tool(name, description?, schema?, annotations, cb)
    const tool = (server.tool as (...args: unknown[]) => unknown)(name, ...rest, annotationsFor(effect), callback) as { inputSchema?: unknown };
    // Refuse, never ignore: the SDK builds a schema that silently drops arguments it does not
    // know, so a misspelt argument (startsAt for date) ran the tool with its defaults and the
    // caller believed it had been used. Strict schemas turn that into an error naming the key.
    // The SDK's schema is a Zod 4 object with the shape on `_zod.def.shape`; rebuild it strict.
    const shape = (tool.inputSchema as { _zod?: { def?: { shape?: z.ZodRawShape } } } | undefined)?._zod?.def?.shape;
    if (tool.inputSchema !== undefined && shape === undefined) {
      throw new Error(`Tool "${name}" has an argument schema that cannot be made strict; give it a plain shape.`);
    }
    tool.inputSchema = z.strictObject(shape ?? {});
    return tool;
  }) as McpServer["tool"];

  registerCalendarTools(filtered, allowed);
  registerChoreTools(filtered);
  registerListTools(filtered);
  registerTaskTools(filtered);
  registerFamilyTools(filtered);
  registerLabelTools(filtered);
  registerMiscTools(filtered);
  registerMessageTools(filtered);
  // Planning tools degrade gracefully without Plus (meals are simply omitted),
  // except plan_week_meals, which needs the meals API.
  registerPlanningTools(filtered);

  if (options.hasPlus) {
    registerRewardTools(filtered);
    registerMealTools(filtered);
    if (options.photos ?? true) registerPhotoTools(filtered);
  }

  return registered;
}
