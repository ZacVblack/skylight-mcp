import { getClient } from "../client.js";
import type {
  TaskBoxItemResponse,
  TaskBoxItemsResponse,
  TaskBoxItemResource,
  CreateTaskBoxItemRequest,
} from "../types.js";

export interface CreateTaskBoxItemOptions {
  summary: string;
  emojiIcon?: string;
  routine?: boolean;
  rewardPoints?: number;
}

/**
 * Create a task box item
 * Task box items are unscheduled tasks that can later be assigned to specific dates
 */
export async function createTaskBoxItem(
  options: CreateTaskBoxItemOptions
): Promise<TaskBoxItemResource> {
  const client = getClient();

  const request: CreateTaskBoxItemRequest = {
    data: {
      type: "task_box_item",
      attributes: {
        summary: options.summary,
        emoji_icon: options.emojiIcon ?? null,
        routine: options.routine ?? false,
        reward_points: options.rewardPoints ?? null,
      },
    },
  };

  const response = await client.post<TaskBoxItemResponse>(
    "/api/frames/{frameId}/task_box/items",
    request
  );

  return response.data;
}

/**
 * List the task box.
 *
 * Shape captured from the web app: GET /task_box/items returns template items
 * (summary, emoji_icon, routine, reward_points). They carry no assignee and no
 * date: the task box is a library of reusable chores, not scheduled work.
 */
export async function listTaskBoxItems(): Promise<TaskBoxItemResource[]> {
  const client = getClient();
  const response = await client.get<TaskBoxItemsResponse>("/api/frames/{frameId}/task_box/items");
  if (!Array.isArray(response.data)) {
    // Never report "empty" for a shape we don't recognise. Keys only: values could be personal.
    const keys = response && typeof response === "object" ? Object.keys(response).join(", ") : typeof response;
    throw new Error(`Unexpected task box response (top-level keys: ${keys || "none"})`);
  }
  return response.data;
}

/**
 * Delete a Task Box template: `DELETE /task_box/items/{id}` (captured from the web app: 204, no body,
 * no query). Chores already scheduled from the template are not touched (observed for a one-off chore).
 */
export async function deleteTaskBoxItem(itemId: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/task_box/items/${encodeURIComponent(itemId)}`, {
    method: "DELETE",
  });
}
