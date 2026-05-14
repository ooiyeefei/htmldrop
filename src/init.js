import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeConfig, ensureSiteDir, getSiteDir, readConfig } from './config.js';

function prompt(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getSurgeCommand() {
  try {
    execSync('which surge', { stdio: 'ignore' });
    return 'surge';
  } catch {
    return 'npx surge';
  }
}

export async function init() {
  const existing = readConfig();
  if (existing && existing.subdomain) {
    const proceed = await prompt(
      `You already have a config (subdomain: ${existing.subdomain}). Reconfigure? [y/N] `
    );
    if (proceed.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  console.log('\n--- htmldrop setup ---\n');
  console.log('Step 1: Choose a subdomain\n');
  console.log('Your files will be available at: https://<subdomain>.surge.sh/');
  console.log('Pick something memorable (letters, numbers, hyphens only).\n');

  const subdomain = await prompt('Subdomain: ');

  if (!subdomain) {
    throw new Error('Subdomain is required.');
  }

  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(subdomain)) {
    throw new Error(
      'Invalid subdomain. Use lowercase letters, numbers, and hyphens only. ' +
      'Must start and end with a letter or number.'
    );
  }

  const config = { subdomain, email: '' };
  writeConfig(config);
  ensureSiteDir();

  console.log('\nStep 2: First deploy (Surge login)\n');
  console.log('Surge will now ask for your email and password.');
  console.log('If you don\'t have an account, it will create one.\n');
  console.log('After this first login, future deploys are automatic.\n');

  // Deploy an initial placeholder to trigger Surge's interactive login
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const siteDir = getSiteDir();

  // Add robots.txt to block all crawlers at site level
  const robotsPath = join(siteDir, 'robots.txt');
  writeFileSync(robotsPath, `User-agent: *\nDisallow: /\n`, 'utf-8');

  const placeholderPath = join(siteDir, 'index.html');
  writeFileSync(placeholderPath, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${subdomain}</title></head>
<body><h1>${subdomain}</h1><p>htmldrop site ready. Push files with <code>htmldrop push</code>.</p></body>
</html>`, 'utf-8');

  const surgeCmd = getSurgeCommand();
  const domain = `${subdomain}.surge.sh`;

  try {
    // This triggers interactive email/password prompt on first run
    // After login, token is saved to ~/.netrc for future deploys
    execSync(`${surgeCmd} ${siteDir} --domain ${domain}`, { stdio: 'inherit' });
  } catch {
    throw new Error(
      'Surge deploy failed. Make sure you have internet connectivity and try again.'
    );
  }

  // Try to get email from surge whoami (after successful login)
  try {
    const email = execSync(`${surgeCmd} whoami`, { encoding: 'utf-8' }).trim();
    config.email = email;
    writeConfig(config);
  } catch {
    // Not critical
  }

  console.log(`\nDone! Your site is live at: https://${domain}/`);
  console.log(`\nRun \`htmldrop push <file.html>\` to publish your first file.`);
}
