import {dirname, delimiter} from 'node:path';
import type {ProcessEnvironmentPolicy} from './types.js';

const DEFAULT_INHERITED_VARIABLES = ['HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

export function buildChildEnvironment(
  executable: string,
  policy: ProcessEnvironmentPolicy = {},
): NodeJS.ProcessEnv {
  const inheritedNames = policy.inherit ?? DEFAULT_INHERITED_VARIABLES;
  const environment: NodeJS.ProcessEnv = {};

  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }

  const executableDirectory = dirname(executable);
  const inheritPath = policy.inheritPath ?? true;
  const prependExecutableDirectory = policy.prependExecutableDirectoryToPath ?? true;
  const inheritedPath = inheritPath ? (process.env.PATH ?? '') : '';
  const pathEntries = inheritedPath.split(delimiter).filter(Boolean);
  const path = prependExecutableDirectory
    ? [executableDirectory, ...pathEntries.filter((entry) => entry !== executableDirectory)]
    : pathEntries;

  if (path.length > 0) environment.PATH = path.join(delimiter);

  for (const [name, value] of Object.entries(policy.values ?? {})) {
    environment[name] = value;
  }

  return environment;
}
