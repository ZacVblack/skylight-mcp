/**
 * Structural checks for the text written to a meal: its name, note and
 * instructions. This text is shown on every device in the house, so the worst
 * failures (a literal placeholder, a stale or oversized field) are caught
 * before a write, not by someone reading the wall display.
 *
 * Only structure is checked, never taste. Errors block a real write; warnings
 * are advice and never block.
 */

export interface MealTextFields {
  summary?: string;
  note?: string;
  description?: string;
}

export interface MealTextFindings {
  errors: string[];
  warnings: string[];
}

/** Aim for this many characters in a name; the hard ceiling includes a dessert. */
export const NAME_TARGET = 25;
export const NAME_CEILING = 35;

// Text in (), [] or <> that stands in for something missing: "(plan doc URL)",
// "[recipe link]", "<dessert name>", "(steps to fill in)", "(recipe URL needed)".
const BRACKETED_PLACEHOLDER = /[([<][^)\]>\n]*\b(?:url|link|needed|to fill in|fill in|placeholder|tbd|todo|dessert name|recipe name|plan doc)\b[^)\]>\n]*[)\]>]/i;
const BARE_PLACEHOLDER = /\b(?:tbd|todo|xxx|lorem ipsum)\b/i;

// Cooking verbs that read as steps. A note is for family notes, not steps.
const COOKING_STEP = /\b(?:preheat|simmer|whisk|knead|saut[eé]|soft-boil|boil|sear)\b/i;

function placeholderIn(value: string): string | undefined {
  const bracketed = BRACKETED_PLACEHOLDER.exec(value);
  if (bracketed) return bracketed[0];
  const bare = BARE_PLACEHOLDER.exec(value);
  return bare ? bare[0] : undefined;
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

export function checkMealText(fields: MealTextFields): MealTextFindings {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [label, value] of [
    ["name", fields.summary],
    ["note", fields.note],
    ["instructions", fields.description],
  ] as const) {
    if (!value) continue;
    const found = placeholderIn(value);
    if (found) errors.push(`${label} contains a placeholder: ${JSON.stringify(found)}. Fill it in or remove it.`);
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(value)) warnings.push(`${label} has non-ASCII characters (emoji or smart quotes), which can show as boxes on some displays.`);
  }

  const name = fields.summary?.trim();
  if (name) {
    if (name.length > NAME_CEILING) {
      warnings.push(`name is ${name.length} characters, over the ${NAME_CEILING} ceiling; the month view clips long names.`);
    } else if (name.length > NAME_TARGET && !name.includes(" + ")) {
      warnings.push(`name is ${name.length} characters; aim for ${NAME_TARGET} or fewer.`);
    }
    const dessert = /^.+ \+ (.+)$/.exec(name);
    if (dessert && wordCount(dessert[1]!) > 2) {
      warnings.push(`dessert in the name ("${dessert[1]}") is ${wordCount(dessert[1]!)} words; keep it to two.`);
    }
  }

  if (fields.note && COOKING_STEP.test(fields.note)) {
    warnings.push("note looks like it holds a cooking step; steps belong in the instructions.");
  }

  return { errors, warnings };
}
