import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
/** Terminal-only prompts. Secret characters are never echoed or returned to logs. */
export function terminalPrompts() {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: stdin, output, terminal: !!stdin.isTTY });
  return {
    async ask(label: string, secret = false) {
      if (!secret) return rl.question(label);
      stdout.write(label);
      muted = true;
      try {
        return await rl.question("");
      } finally {
        muted = false;
        stdout.write("\n");
      }
    },
    close() {
      rl.close();
    },
  };
}
