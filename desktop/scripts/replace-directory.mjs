import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function replaceDirectoryAtomically(stagingDir, destinationDir) {
  const parent = path.dirname(destinationDir);
  const backupDir = path.join(parent, `.${path.basename(destinationDir)}.${randomUUID()}.bak`);
  const hadDestination = fs.existsSync(destinationDir);

  if (hadDestination) fs.renameSync(destinationDir, backupDir);
  try {
    fs.renameSync(stagingDir, destinationDir);
  } catch (error) {
    if (hadDestination) fs.renameSync(backupDir, destinationDir);
    throw error;
  }

  if (hadDestination) fs.rmSync(backupDir, { recursive: true, force: true });
}
