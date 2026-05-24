import { createInterface } from 'node:readline';

// Prompt for a secret without echoing it to the terminal.
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(
        'No interactive terminal to prompt for a password. ' +
        'Set HTMLDROP_PASSWORD or pass --password <pw>.'
      ));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = function (stringToWrite) {
      // Suppress echo of the typed characters; let everything else through.
      if (!rl.stdoutMuted) rl.output.write(stringToWrite);
    };
    process.stdout.write(question);
    rl.question('', (value) => {
      rl.stdoutMuted = false;
      rl.close();
      process.stdout.write('\n');
      resolve(value);
    });
  });
}

// Resolve a password from the safest available source.
//   - a string value (from `--password <pw>`)  → used as-is (discouraged: lands in shell history)
//   - `true` (bare `--password` flag)           → HTMLDROP_PASSWORD env, else a hidden prompt
//   - undefined / falsy                         → undefined (no password)
export async function resolvePassword(passwordOption) {
  if (typeof passwordOption === 'string' && passwordOption.length > 0) {
    return passwordOption;
  }
  if (passwordOption === true) {
    if (process.env.HTMLDROP_PASSWORD) return process.env.HTMLDROP_PASSWORD;
    return promptHidden('Password: ');
  }
  return undefined;
}
