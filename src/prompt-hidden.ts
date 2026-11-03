/**
 * Read one line from the terminal without echoing it. Used for a calendar feed
 * address, which works like a password: it must not appear on screen, in shell
 * history, or in anything that captures the terminal.
 */

export interface HiddenInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  setEncoding?: (encoding: string) => unknown;
  on: (event: "data" | "end", listener: (chunk?: string) => void) => unknown;
  off: (event: "data" | "end", listener: (chunk?: string) => void) => unknown;
}

export interface HiddenOutput {
  write: (text: string) => unknown;
}

export class PromptCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "PromptCancelled";
  }
}

export async function promptHidden(
  question: string,
  io: { input: HiddenInput; output: HiddenOutput } = {
    input: process.stdin as unknown as HiddenInput,
    output: process.stderr,
  }
): Promise<string> {
  const { input, output } = io;
  output.write(question);
  const raw = Boolean(input.isTTY && input.setRawMode);
  if (raw) input.setRawMode!(true);
  input.setEncoding?.("utf8");
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (result: () => void) => {
      input.off("data", onData);
      input.off("end", onEnd);
      if (raw) input.setRawMode!(false);
      input.pause();
      result();
    };
    const onEnd = () => finish(() => resolve(value));
    // Nothing typed is shown, so a paste looks like it did nothing and gets repeated. A live
    // count (never the text) is the only sign that it landed.
    const showCount = () => {
      if (raw) output.write(`\r\u001b[K${question}${value.length} characters (not shown). Press Enter to submit.`);
    };
    const onData = (chunk?: string) => {
      for (const ch of chunk ?? "") {
        if (ch === "\r" || ch === "\n") {
          output.write(`\nGot it (${value.length} characters, not shown).\n`);
          return finish(() => resolve(value));
        }
        if (ch === "\u0003") {
          output.write("\n");
          return finish(() => reject(new PromptCancelled()));
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= " ") value += ch;
      }
      showCount();
    };
    input.on("data", onData);
    input.on("end", onEnd);
  });
}
