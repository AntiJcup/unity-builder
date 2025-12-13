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
    let kubectlLogsFailedCount = 0;
    const maxKubectlLogsFailures = 3;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      CloudRunnerLogger.log(
        `Streaming logs from pod: ${podName} container: ${containerName} namespace: ${namespace} ${CloudRunner.buildParameters.kubeVolumeSize}/${CloudRunner.buildParameters.containerCpu}/${CloudRunner.buildParameters.containerMemory}`,
      );
      const isRunning = await KubernetesPods.IsPodRunning(podName, namespace, kubeClient);

      const callback = (outputChunk: string) => {
        // Filter out kubectl error messages about being unable to retrieve container logs
        // These errors pollute the output and don't contain useful information
        const lowerChunk = outputChunk.toLowerCase();
        if (lowerChunk.includes('unable to retrieve container logs')) {
          CloudRunnerLogger.log(`Filtered kubectl error: ${outputChunk.trim()}`);
          return;
        }

        output += outputChunk;

        // split output chunk and handle per line
        for (const chunk of outputChunk.split(`\n`)) {
          // Skip empty chunks and kubectl error messages (case-insensitive)
          const lowerChunk = chunk.toLowerCase();
          if (chunk.trim() && !lowerChunk.includes('unable to retrieve container logs')) {
            ({ shouldReadLogs, shouldCleanup, output } = FollowLogStreamService.handleIteration(
              chunk,
              shouldReadLogs,
              shouldCleanup,
              output,
            ));
          }
        }
      };
      try {
        // Always specify container name explicitly to avoid containerd:// errors
        // Use -f for running pods, --previous for terminated pods
        await CloudRunnerSystem.Run(
          `kubectl logs ${podName} -c ${containerName} -n ${namespace}${isRunning ? ' -f' : ' --previous'}`,
          false,
          true,
          callback,
        );
        // Reset failure count on success
        kubectlLogsFailedCount = 0;
      } catch (error: any) {
        kubectlLogsFailedCount++;
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const continueStreaming = await KubernetesPods.IsPodRunning(podName, namespace, kubeClient);
        CloudRunnerLogger.log(`K8s logging error ${error} ${continueStreaming}`);

        // Filter out kubectl error messages from the error output
        const errorMessage = error?.message || error?.toString() || '';
        const isKubectlLogsError =
          errorMessage.includes('unable to retrieve container logs for containerd://') ||
          errorMessage.toLowerCase().includes('unable to retrieve container logs');

        if (isKubectlLogsError) {
          CloudRunnerLogger.log(
            `Kubectl unable to retrieve logs, attempt ${kubectlLogsFailedCount}/${maxKubectlLogsFailures}`,
          );

          // If kubectl logs has failed multiple times, try reading the log file directly from the pod
          // This works even if the pod is terminated, as long as it hasn't been deleted
          if (kubectlLogsFailedCount >= maxKubectlLogsFailures && !isRunning && !continueStreaming) {
            CloudRunnerLogger.log(`Attempting to read log file directly from pod as fallback...`);
            try {
              // Try to read the log file from the pod
              // Use kubectl exec for running pods, or try to access via PVC if pod is terminated
              let logFileContent = '';

              if (isRunning) {
                // Pod is still running, try exec
                logFileContent = await CloudRunnerSystem.Run(
                  `kubectl exec ${podName} -c ${containerName} -n ${namespace} -- cat /home/job-log.txt 2>/dev/null || echo ""`,
                  true,
                  true,
                );
              } else {
                // Pod is terminated, try to create a temporary pod to read from the PVC
                // First, check if we can still access the pod's filesystem
                CloudRunnerLogger.log(`Pod is terminated, attempting to read log file via temporary pod...`);
                // For terminated pods, we might not be able to exec, so we'll skip this fallback
                // and rely on the log file being written to the PVC (if mounted)
                CloudRunnerLogger.logWarning(`Cannot read log file from terminated pod via exec`);
              }

              if (logFileContent && logFileContent.trim()) {
                CloudRunnerLogger.log(`Successfully read log file from pod (${logFileContent.length} chars)`);
                // Process the log file content line by line
                for (const line of logFileContent.split(`\n`)) {
                  const lowerLine = line.toLowerCase();
                  if (line.trim() && !lowerLine.includes('unable to retrieve container logs')) {
                    ({ shouldReadLogs, shouldCleanup, output } = FollowLogStreamService.handleIteration(
                      line,
                      shouldReadLogs,
                      shouldCleanup,
                      output,
                    ));
                  }
                }

                // Check if we got the end of transmission marker
                if (FollowLogStreamService.DidReceiveEndOfTransmission) {
                  CloudRunnerLogger.log('end of log stream (from log file)');
                  break;
                }
              } else {
                CloudRunnerLogger.logWarning(`Log file read returned empty content, continuing with available logs`);
                // If we can't read the log file, break out of the loop to return whatever logs we have
                // This prevents infinite retries when kubectl logs consistently fails
                break;
              }
            } catch (execError: any) {
              CloudRunnerLogger.logWarning(`Failed to read log file from pod: ${execError}`);
              // If we've exhausted all options, break to return whatever logs we have
              break;
            }
          }
        }

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

    // After kubectl logs loop ends, read log file as fallback to capture any messages
    // written after kubectl stopped reading (e.g., "Collected Logs" from post-build)
    // This ensures all log messages are included in BuildResults for test assertions
    try {
      const isPodStillRunning = await KubernetesPods.IsPodRunning(podName, namespace, kubeClient);
      if (!isPodStillRunning) {
        CloudRunnerLogger.log('Pod is terminated, reading log file as fallback to capture post-build messages...');
        try {
          // Try to read the log file from the terminated pod
          // For killed pods (OOM), kubectl exec might not work, so we try multiple approaches
          // First try --previous flag for terminated containers, then try without it
          let logFileContent = '';
          try {
            logFileContent = await CloudRunnerSystem.Run(
              `kubectl exec ${podName} -c ${containerName} -n ${namespace} --previous -- cat /home/job-log.txt 2>/dev/null || echo ""`,
              true,
              true,
            );
          } catch {
            // If --previous fails, try without it (for recently terminated pods)
            try {
              logFileContent = await CloudRunnerSystem.Run(
                `kubectl exec ${podName} -c ${containerName} -n ${namespace} -- cat /home/job-log.txt 2>/dev/null || echo ""`,
                true,
                true,
              );
            } catch {
              // If both fail (pod might be killed/OOM), log but continue with existing output
              CloudRunnerLogger.logWarning(
                'Could not read log file from terminated pod (may be OOM-killed). Using available logs.',
              );
              logFileContent = '';
            }
          }

          if (logFileContent && logFileContent.trim()) {
            CloudRunnerLogger.log(
              `Read log file from pod as fallback (${logFileContent.length} chars) to capture missing messages`,
            );
            // Get the lines we already have in output to avoid duplicates
            const existingLines = new Set(output.split('\n').map((line) => line.trim()));
            // Process the log file content line by line and add missing lines
            for (const line of logFileContent.split(`\n`)) {
              const trimmedLine = line.trim();
              const lowerLine = trimmedLine.toLowerCase();
              // Skip empty lines, kubectl errors, and lines we already have
              if (
                trimmedLine &&
                !lowerLine.includes('unable to retrieve container logs') &&
                !existingLines.has(trimmedLine)
              ) {
                // Add missing line to output
                output += `${line}\n`;
                // Process through FollowLogStreamService to ensure proper handling
                ({ shouldReadLogs, shouldCleanup, output } = FollowLogStreamService.handleIteration(
                  line,
                  shouldReadLogs,
                  shouldCleanup,
                  output,
                ));
              }
            }
          }
        } catch (logFileError: any) {
          CloudRunnerLogger.logWarning(
            `Could not read log file from pod as fallback: ${logFileError?.message || logFileError}`,
          );
          // Continue with existing output - this is a best-effort fallback
        }
      }
    } catch (fallbackError: any) {
      CloudRunnerLogger.logWarning(
        `Error checking pod status for log file fallback: ${fallbackError?.message || fallbackError}`,
      );
      // Continue with existing output - this is a best-effort fallback
    }

    // Filter out kubectl error messages from the final output
    // These errors can be added via stderr even when kubectl fails
    // We filter them out so they don't pollute the BuildResults
    const lines = output.split('\n');
    const filteredLines = lines.filter((line) => !line.toLowerCase().includes('unable to retrieve container logs'));
    const filteredOutput = filteredLines.join('\n');

    // Log if we filtered out significant content
    const originalLineCount = lines.length;
    const filteredLineCount = filteredLines.length;
    if (originalLineCount > filteredLineCount) {
      CloudRunnerLogger.log(
        `Filtered out ${originalLineCount - filteredLineCount} kubectl error message(s) from output`,
      );
    }

    return filteredOutput;
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
