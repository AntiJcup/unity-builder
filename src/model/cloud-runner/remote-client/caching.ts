import { assert } from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import CloudRunner from '../cloud-runner';
import CloudRunnerLogger from '../services/core/cloud-runner-logger';
import { CloudRunnerFolders } from '../options/cloud-runner-folders';
import { CloudRunnerSystem } from '../services/core/cloud-runner-system';
import { LfsHashing } from '../services/utility/lfs-hashing';
import { RemoteClientLogger } from './remote-client-logger';
import { Cli } from '../../cli/cli';
import { CliFunction } from '../../cli/cli-functions-repository';
// eslint-disable-next-line github/no-then
const fileExists = async (fpath: fs.PathLike) => !!(await fs.promises.stat(fpath).catch(() => false));

export class Caching {
  @CliFunction(`cache-push`, `push to cache`)
  static async cachePush() {
    try {
      const buildParameter = JSON.parse(process.env.BUILD_PARAMETERS || '{}');
      CloudRunner.buildParameters = buildParameter;
      await Caching.PushToCache(
        Cli.options!['cachePushTo'],
        Cli.options!['cachePushFrom'],
        Cli.options!['artifactName'] || '',
      );
    } catch (error: any) {
      CloudRunnerLogger.log(`${error}`);
    }
  }

  @CliFunction(`cache-pull`, `pull from cache`)
  static async cachePull() {
    try {
      const buildParameter = JSON.parse(process.env.BUILD_PARAMETERS || '{}');
      CloudRunner.buildParameters = buildParameter;
      await Caching.PullFromCache(
        Cli.options!['cachePushFrom'],
        Cli.options!['cachePushTo'],
        Cli.options!['artifactName'] || '',
      );
    } catch (error: any) {
      CloudRunnerLogger.log(`${error}`);
    }
  }

  public static async PushToCache(cacheFolder: string, sourceFolder: string, cacheArtifactName: string) {
    CloudRunnerLogger.log(`Pushing to cache ${sourceFolder}`);
    cacheArtifactName = cacheArtifactName.replace(' ', '');
    const startPath = process.cwd();
    let compressionSuffix = '';
    if (CloudRunner.buildParameters.useCompressionStrategy === true) {
      compressionSuffix = `.lz4`;
    }
    CloudRunnerLogger.log(`Compression: ${CloudRunner.buildParameters.useCompressionStrategy} ${compressionSuffix}`);
    try {
      if (!(await fileExists(cacheFolder))) {
        await CloudRunnerSystem.Run(`mkdir -p ${cacheFolder}`);
      }
      process.chdir(path.resolve(sourceFolder, '..'));

      if (CloudRunner.buildParameters.cloudRunnerDebug === true) {
        CloudRunnerLogger.log(
          `Hashed cache folder ${await LfsHashing.hashAllFiles(sourceFolder)} ${sourceFolder} ${path.basename(
            sourceFolder,
          )}`,
        );
      }
      const contents = await fs.promises.readdir(path.basename(sourceFolder));
      CloudRunnerLogger.log(
        `There is ${contents.length} files/dir in the source folder ${path.basename(sourceFolder)}`,
      );

      if (contents.length === 0) {
        CloudRunnerLogger.log(
          `Did not push source folder to cache because it was empty ${path.basename(sourceFolder)}`,
        );
        process.chdir(`${startPath}`);

        return;
      }

      // Check disk space before creating tar archive
      try {
        const diskCheckOutput = await CloudRunnerSystem.Run(`df -h . 2>/dev/null || df -h /data 2>/dev/null || true`);
        CloudRunnerLogger.log(`Disk space before tar: ${diskCheckOutput}`);
      } catch (error) {
        // Ignore disk check errors
      }

      // Clean up any existing incomplete tar files
      try {
        await CloudRunnerSystem.Run(`rm -f ${cacheArtifactName}.tar${compressionSuffix} 2>/dev/null || true`);
      } catch (error) {
        // Ignore cleanup errors
      }

      try {
        await CloudRunnerSystem.Run(
          `tar -cf ${cacheArtifactName}.tar${compressionSuffix} "${path.basename(sourceFolder)}"`,
        );
      } catch (error: any) {
        // Check if error is due to disk space
        const errorMessage = error?.message || error?.toString() || '';
        if (errorMessage.includes('No space left') || errorMessage.includes('Wrote only')) {
          CloudRunnerLogger.log(`Disk space error detected. Attempting cleanup...`);
          // Try to clean up old cache files
          try {
            const cacheParent = path.dirname(cacheFolder);
            if (await fileExists(cacheParent)) {
              // Find and remove old cache entries (keep only the most recent)
              await CloudRunnerSystem.Run(
                `find ${cacheParent} -name "*.tar*" -type f -mtime +1 -delete 2>/dev/null || true`,
              );
            }
          } catch (cleanupError) {
            CloudRunnerLogger.log(`Cleanup attempt failed: ${cleanupError}`);
          }
          throw new Error(
            `Failed to create cache archive due to insufficient disk space. Error: ${errorMessage}. Please free up disk space and retry.`,
          );
        }
        throw error;
      }
      await CloudRunnerSystem.Run(`du ${cacheArtifactName}.tar${compressionSuffix}`);
      assert(await fileExists(`${cacheArtifactName}.tar${compressionSuffix}`), 'cache archive exists');
      assert(await fileExists(path.basename(sourceFolder)), 'source folder exists');
      await CloudRunnerSystem.Run(`mv ${cacheArtifactName}.tar${compressionSuffix} ${cacheFolder}`);
      RemoteClientLogger.log(`moved cache entry ${cacheArtifactName} to ${cacheFolder}`);
      assert(
        await fileExists(`${path.join(cacheFolder, cacheArtifactName)}.tar${compressionSuffix}`),
        'cache archive exists inside cache folder',
      );
    } catch (error) {
      process.chdir(`${startPath}`);
      throw error;
    }
    process.chdir(`${startPath}`);
  }
  public static async PullFromCache(cacheFolder: string, destinationFolder: string, cacheArtifactName: string = ``) {
    CloudRunnerLogger.log(`Pulling from cache ${destinationFolder} ${CloudRunner.buildParameters.skipCache}`);
    if (`${CloudRunner.buildParameters.skipCache}` === `true`) {
      CloudRunnerLogger.log(`Skipping cache debugSkipCache is true`);

      return;
    }
    cacheArtifactName = cacheArtifactName.replace(' ', '');
    let compressionSuffix = '';
    if (CloudRunner.buildParameters.useCompressionStrategy === true) {
      compressionSuffix = `.lz4`;
    }
    const startPath = process.cwd();
    RemoteClientLogger.log(`Caching for (lz4 ${compressionSuffix}) ${path.basename(destinationFolder)}`);
    try {
      if (!(await fileExists(cacheFolder))) {
        await fs.promises.mkdir(cacheFolder);
      }

      if (!(await fileExists(destinationFolder))) {
        await fs.promises.mkdir(destinationFolder);
      }

      const latestInBranch = await (
        await CloudRunnerSystem.Run(`ls -t "${cacheFolder}" | grep .tar${compressionSuffix}$ | head -1`)
      )
        .replace(/\n/g, ``)
        .replace(`.tar${compressionSuffix}`, '');

      process.chdir(cacheFolder);

      const cacheSelection =
        cacheArtifactName !== `` && (await fileExists(`${cacheArtifactName}.tar${compressionSuffix}`))
          ? cacheArtifactName
          : latestInBranch;
      await CloudRunnerLogger.log(`cache key ${cacheArtifactName} selection ${cacheSelection}`);

      if (await fileExists(`${cacheSelection}.tar${compressionSuffix}`)) {
        const resultsFolder = `results${CloudRunner.buildParameters.buildGuid}`;
        await CloudRunnerSystem.Run(`mkdir -p ${resultsFolder}`);
        RemoteClientLogger.log(`cache item exists ${cacheFolder}/${cacheSelection}.tar${compressionSuffix}`);
        const fullResultsFolder = path.join(cacheFolder, resultsFolder);
        await CloudRunnerSystem.Run(`tar -xf ${cacheSelection}.tar${compressionSuffix} -C ${fullResultsFolder}`);
        RemoteClientLogger.log(`cache item extracted to ${fullResultsFolder}`);
        assert(await fileExists(fullResultsFolder), `cache extraction results folder exists`);
        const destinationParentFolder = path.resolve(destinationFolder, '..');

        if (await fileExists(destinationFolder)) {
          await fs.promises.rmdir(destinationFolder, { recursive: true });
        }
        await CloudRunnerSystem.Run(
          `mv "${path.join(fullResultsFolder, path.basename(destinationFolder))}" "${destinationParentFolder}"`,
        );
        const contents = await fs.promises.readdir(
          path.join(destinationParentFolder, path.basename(destinationFolder)),
        );
        CloudRunnerLogger.log(
          `There is ${contents.length} files/dir in the cache pulled contents for ${path.basename(destinationFolder)}`,
        );
      } else {
        RemoteClientLogger.logWarning(`cache item ${cacheArtifactName} doesn't exist ${destinationFolder}`);
        if (cacheSelection !== ``) {
          RemoteClientLogger.logWarning(
            `cache item ${cacheArtifactName}.tar${compressionSuffix} doesn't exist ${destinationFolder}`,
          );
          throw new Error(`Failed to get cache item, but cache hit was found: ${cacheSelection}`);
        }
      }
    } catch (error) {
      process.chdir(startPath);
      throw error;
    }
    process.chdir(startPath);
  }

  public static async handleCachePurging() {
    if (process.env.PURGE_REMOTE_BUILDER_CACHE !== undefined) {
      RemoteClientLogger.log(`purging ${CloudRunnerFolders.purgeRemoteCaching}`);
      fs.promises.rmdir(CloudRunnerFolders.cacheFolder, { recursive: true });
    }
  }
}
