import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import CloudRunnerLogger from '../../services/core/cloud-runner-logger';
import { waitUntil } from 'async-wait-until';
import { CloudRunnerSystem } from '../../services/core/cloud-runner-system';
import CloudRunner from '../../cloud-runner';
import KubernetesPods from './kubernetes-pods';
import { FollowLogStreamService } from '../../services/core/follow-log-stream-service';

class KubernetesTaskRunner {
  static readonly maxRetry: number = 3;
  static lastReceivedMessage: string = ``;

  static async runTask(
    kubeConfig: KubeConfig,
    kubeClient: CoreV1Api,
    jobName: string,
    podName: string,
    containerName: string,
    namespace: string,
  ) {
    let output = '';
    let shouldReadLogs = true;
    let shouldCleanup = true;
    let retriesAfterFinish = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      CloudRunnerLogger.log(
        `Streaming logs from pod: ${podName} container: ${containerName} namespace: ${namespace} ${CloudRunner.buildParameters.kubeVolumeSize}/${CloudRunner.buildParameters.containerCpu}/${CloudRunner.buildParameters.containerMemory}`,
      );
      const isRunning = await KubernetesPods.IsPodRunning(podName, namespace, kubeClient);
      let extraFlags = ``;
      extraFlags += isRunning ? ` -f -c ${containerName} -n ${namespace}` : ` --previous -n ${namespace}`;

      const callback = (outputChunk: string) => {
        output += outputChunk;

        // split output chunk and handle per line
        for (const chunk of outputChunk.split(`\n`)) {
          ({ shouldReadLogs, shouldCleanup, output } = FollowLogStreamService.handleIteration(
            chunk,
            shouldReadLogs,
            shouldCleanup,
            output,
          ));
        }
      };
      try {
        await CloudRunnerSystem.Run(`kubectl logs ${podName}${extraFlags}`, false, true, callback);
      } catch (error: any) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const continueStreaming = await KubernetesPods.IsPodRunning(podName, namespace, kubeClient);
        CloudRunnerLogger.log(`K8s logging error ${error} ${continueStreaming}`);

        // If pod is not running and we tried --previous but it failed, try without --previous
        if (!isRunning && !continueStreaming && error?.message?.includes('previous terminated container')) {
          CloudRunnerLogger.log(`Previous container not found, trying current container logs...`);
          try {
            await CloudRunnerSystem.Run(
              `kubectl logs ${podName} -c ${containerName} -n ${namespace}`,
              false,
              true,
              callback,
            );

            // If we successfully got logs, check for end of transmission
            if (FollowLogStreamService.DidReceiveEndOfTransmission) {
              CloudRunnerLogger.log('end of log stream');
              break;
            }

            // If we got logs but no end marker, continue trying (might be more logs)
            if (retriesAfterFinish < KubernetesTaskRunner.maxRetry) {
              retriesAfterFinish++;
              continue;
            }

            // If we've exhausted retries, break
            break;
          } catch (fallbackError: any) {
            CloudRunnerLogger.log(`Fallback log fetch also failed: ${fallbackError}`);

            // If both fail, continue retrying if we haven't exhausted retries
            if (retriesAfterFinish < KubernetesTaskRunner.maxRetry) {
              retriesAfterFinish++;
              continue;
            }

            // Only break if we've exhausted all retries
            CloudRunnerLogger.logWarning(
              `Could not fetch any container logs after ${KubernetesTaskRunner.maxRetry} retries`,
            );
            break;
          }
        }

        if (continueStreaming) {
          continue;
        }
        if (retriesAfterFinish < KubernetesTaskRunner.maxRetry) {
          retriesAfterFinish++;
          continue;
        }

        // If we've exhausted retries and it's not a previous container issue, throw
        if (!error?.message?.includes('previous terminated container')) {
          throw error;
        }

        // For previous container errors, we've already tried fallback, so just break
        CloudRunnerLogger.logWarning(
          `Could not fetch previous container logs after retries, but continuing with available logs`,
        );
        break;
      }
      if (FollowLogStreamService.DidReceiveEndOfTransmission) {
        CloudRunnerLogger.log('end of log stream');
        break;
      }
    }

    return output;
  }

  static async watchUntilPodRunning(kubeClient: CoreV1Api, podName: string, namespace: string) {
    let waitComplete: boolean = false;
    let message = ``;
    CloudRunnerLogger.log(`Watching ${podName} ${namespace}`);
    await waitUntil(
      async () => {
        const status = await kubeClient.readNamespacedPodStatus(podName, namespace);
        const phase = status?.body.status?.phase;
        waitComplete = phase !== 'Pending';
        message = `Phase:${status.body.status?.phase} \n Reason:${
          status.body.status?.conditions?.[0].reason || ''
        } \n Message:${status.body.status?.conditions?.[0].message || ''}`;

        // CloudRunnerLogger.log(
        //   JSON.stringify(
        //     (await kubeClient.listNamespacedEvent(namespace)).body.items
        //       .map((x) => {
        //         return {
        //           message: x.message || ``,
        //           name: x.metadata.name || ``,
        //           reason: x.reason || ``,
        //         };
        //       })
        //       .filter((x) => x.name.includes(podName)),
        //     undefined,
        //     4,
        //   ),
        // );
        if (waitComplete || phase !== 'Pending') return true;

        return false;
      },
      {
        timeout: 2000000,
        intervalBetweenAttempts: 15000,
      },
    );
    if (!waitComplete) {
      CloudRunnerLogger.log(message);
    }

    return waitComplete;
  }
}

export default KubernetesTaskRunner;
