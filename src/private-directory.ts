import {lstat, mkdir} from 'node:fs/promises';
import {ProcessSupervisorError} from './errors.js';

const PRIVATE_PERMISSION_MASK = 0o077;

export async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, {recursive: true, mode: 0o700});
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw unsafe(`${label} must be a real directory, not a symlink or another file type: ${path}`);
    }

    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw unsafe(`${label} must be owned by the current user: ${path}`);
    }

    if (typeof process.getuid === 'function' && (info.mode & PRIVATE_PERMISSION_MASK) !== 0) {
      throw unsafe(`${label} must not be accessible by group or other users: ${path}`);
    }
  } catch (error) {
    if (error instanceof ProcessSupervisorError) throw error;
    throw new ProcessSupervisorError(
      'STATE_DIRECTORY_UNSAFE',
      `Could not establish a private ${label.toLowerCase()}: ${path}`,
      {cause: error},
    );
  }
}

function unsafe(message: string): ProcessSupervisorError {
  return new ProcessSupervisorError('STATE_DIRECTORY_UNSAFE', message);
}
