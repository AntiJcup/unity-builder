import BuildParameters from '../../../build-parameters';
import { CloudRunnerSystem } from '../../services/core/cloud-runner-system';
import CloudRunnerEnvironmentVariable from '../../options/cloud-runner-environment-variable';
import CloudRunnerLogger from '../../services/core/cloud-runner-logger';
import { ProviderInterface } from '../provider-interface';
import CloudRunnerSecret from '../../options/cloud-runner-secret';
import { ProviderResource } from '../provider-resource';
import { ProviderWorkflow } from '../provider-workflow';

class LocalCloudRunner implements ProviderInterface {
  listResources(): Promise<ProviderResource[]> {
    throw new Error('Method not implemented.');
  }
  listWorkflow(): Promise<ProviderWorkflow[]> {
    throw new Error('Method not implemented.');
  }
  watchWorkflow(): Promise<string> {
    throw new Error('Method not implemented.');
  }
  garbageCollect(
    // eslint-disable-next-line no-unused-vars
    filter: string,
    // eslint-disable-next-line no-unused-vars
    previewOnly: boolean,
    // eslint-disable-next-line no-unused-vars
    olderThan: Number,
    // eslint-disable-next-line no-unused-vars
    fullCache: boolean,
    // eslint-disable-next-line no-unused-vars
    baseDependencies: boolean,
  ): Promise<string> {
    throw new Error('Method not implemented.');
  }
  cleanupWorkflow(
    // eslint-disable-next-line no-unused-vars
    buildParameters: BuildParameters,
    // eslint-disable-next-line no-unused-vars
    branchName: string,
    // eslint-disable-next-line no-unused-vars
    defaultSecretsArray: { ParameterKey: string; EnvironmentVariable: string; ParameterValue: string }[],
  ) {}
  public setupWorkflow(
    // eslint-disable-next-line no-unused-vars
    buildGuid: string,
    // eslint-disable-next-line no-unused-vars
    buildParameters: BuildParameters,
    // eslint-disable-next-line no-unused-vars
    branchName: string,
    // eslint-disable-next-line no-unused-vars
    defaultSecretsArray: { ParameterKey: string; EnvironmentVariable: string; ParameterValue: string }[],
  ) {}
  public async runTaskInWorkflow(
    buildGuid: string,
    image: string,
    commands: string,
    // eslint-disable-next-line no-unused-vars
    mountdir: string,
    // eslint-disable-next-line no-unused-vars
    workingdir: string,
    // eslint-disable-next-line no-unused-vars
    environment: CloudRunnerEnvironmentVariable[],
    // eslint-disable-next-line no-unused-vars
    secrets: CloudRunnerSecret[],
  ): Promise<string> {
    CloudRunnerLogger.log(image);
    CloudRunnerLogger.log(buildGuid);
    CloudRunnerLogger.log(commands);

    // On Windows, many built-in hooks use POSIX shell syntax. Execute via bash if available.
    if (process.platform === 'win32') {
      // Properly escape the command string for embedding in a double-quoted bash string.
      // Order matters: backslashes must be escaped first to avoid double-escaping.
      const escapeForBashDoubleQuotes = (stringValue: string): string => {
        return stringValue
          .replace(/\\/g, '\\\\') // Escape backslashes first
          .replace(/\$/g, '\\$') // Escape dollar signs to prevent variable expansion
          .replace(/`/g, '\\`') // Escape backticks to prevent command substitution
          .replace(/"/g, '\\"'); // Escape double quotes
      };

      // Split commands by newlines and escape each line
      const lines = commands
        .replace(/\r/g, '')
        .split('\n')
        .filter((x) => x.trim().length > 0)
        .map((line) => escapeForBashDoubleQuotes(line));

      // Join with semicolons, but don't add semicolon after control flow keywords
      // Control flow keywords that shouldn't be followed by semicolons: then, else, do, fi, done, esac
      const controlFlowKeywords = /\b(then|else|do|fi|done|esac)\s*$/;
      const inline = lines
        .map((line, index) => {
          // Don't add semicolon if this line ends with a control flow keyword
          if (controlFlowKeywords.test(line.trim()) || index === lines.length - 1) {
            return line;
          }

          return `${line} ;`;
        })
        .join(' ');
      const bashWrapped = `bash -lc "${inline}"`;

      return await CloudRunnerSystem.Run(bashWrapped);
    }

    return await CloudRunnerSystem.Run(commands);
  }
}
export default LocalCloudRunner;
