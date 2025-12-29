import { V1EnvVar, V1EnvVarSource, V1SecretKeySelector } from '@kubernetes/client-node';
import BuildParameters from '../../../build-parameters';
import { CommandHookService } from '../../services/hooks/command-hook-service';
import CloudRunnerEnvironmentVariable from '../../options/cloud-runner-environment-variable';
import CloudRunnerSecret from '../../options/cloud-runner-secret';
import CloudRunner from '../../cloud-runner';

class KubernetesJobSpecFactory {
  static getJobSpec(
    command: string,
    image: string,
    mountdir: string,
    workingDirectory: string,
    environment: CloudRunnerEnvironmentVariable[],
    secrets: CloudRunnerSecret[],
    buildGuid: string,
    buildParameters: BuildParameters,
    secretName: string,
    pvcName: string,
    jobName: string,
    k8s: any,
    containerName: string,
    ip: string = '',
  ) {
    const endpointEnvironmentNames = new Set([
      'AWS_S3_ENDPOINT',
      'AWS_ENDPOINT',
      'AWS_CLOUD_FORMATION_ENDPOINT',
      'AWS_ECS_ENDPOINT',
      'AWS_KINESIS_ENDPOINT',
      'AWS_CLOUD_WATCH_LOGS_ENDPOINT',
      'INPUT_AWSS3ENDPOINT',
      'INPUT_AWSENDPOINT',
    ]);
    const adjustedEnvironment = environment.map((x) => {
      let value = x.value;
      if (
        typeof value === 'string' &&
        endpointEnvironmentNames.has(x.name) &&
        (value.startsWith('http://localhost') || value.startsWith('http://127.0.0.1'))
      ) {
        // Replace localhost with host.k3d.internal so pods can access host services
        // This simulates accessing external services (like real AWS S3)
        value = value
          .replace('http://localhost', 'http://host.k3d.internal')
          .replace('http://127.0.0.1', 'http://host.k3d.internal');
      }

      return { name: x.name, value } as CloudRunnerEnvironmentVariable;
    });

    const job = new k8s.V1Job();
    job.apiVersion = 'batch/v1';
    job.kind = 'Job';
    job.metadata = {
      name: jobName,
      labels: {
        app: 'unity-builder',
        buildGuid,
      },
    };
    // Reduce TTL for tests to free up resources faster (default 9999s = ~2.8 hours)
    // For CI/test environments, use shorter TTL (300s = 5 minutes) to prevent disk pressure
    const jobTTL = process.env['cloudRunnerTests'] === 'true' ? 300 : 9999;
    job.spec = {
      ttlSecondsAfterFinished: jobTTL,
      backoffLimit: 0,
      template: {
        spec: {
          terminationGracePeriodSeconds: 90, // Give PreStopHook (60s sleep) time to complete
          volumes: [
            {
              name: 'build-mount',
              persistentVolumeClaim: {
                claimName: pvcName,
              },
            },
          ],
          containers: [
            {
              ttlSecondsAfterFinished: 9999,
              name: containerName,
              image,
              command: ['/bin/sh'],
              args: [
                '-c',
                `${CommandHookService.ApplyHooksToCommands(`${command}\nsleep 2m`, CloudRunner.buildParameters)}`,
              ],

              workingDir: `${workingDirectory}`,
              resources: {
                requests: {
                  memory: `${Number.parseInt(buildParameters.containerMemory) / 1024}G` || '750M',
                  cpu: Number.parseInt(buildParameters.containerCpu) / 1024 || '1',
                },
              },
              env: [
                ...adjustedEnvironment.map((x) => {
                  const environmentVariable = new V1EnvVar();
                  environmentVariable.name = x.name;
                  environmentVariable.value = x.value;

                  return environmentVariable;
                }),
                ...secrets.map((x) => {
                  const secret = new V1EnvVarSource();
                  secret.secretKeyRef = new V1SecretKeySelector();
                  secret.secretKeyRef.key = x.ParameterKey;
                  secret.secretKeyRef.name = secretName;
                  const environmentVariable = new V1EnvVar();
                  environmentVariable.name = x.EnvironmentVariable;
                  environmentVariable.valueFrom = secret;

                  return environmentVariable;
                }),
                { name: 'LOG_SERVICE_IP', value: ip },
              ],
              volumeMounts: [
                {
                  name: 'build-mount',
                  mountPath: `${mountdir}`,
                },
              ],
              lifecycle: {
                preStop: {
                  exec: {
                    command: [
                      '/bin/sh',
                      '-c',
                      'sleep 60; cd /data/builder/action/steps && chmod +x /steps/return_license.sh 2>/dev/null || true; /steps/return_license.sh 2>/dev/null || true',
                    ],
                  },
                },
              },
            },
          ],
          restartPolicy: 'Never',
          // Add tolerations for CI/test environments to allow scheduling even with disk pressure
          // This is acceptable for CI where we aggressively clean up disk space
          tolerations: [
            {
              key: 'node.kubernetes.io/disk-pressure',
              operator: 'Exists',
              effect: 'NoSchedule',
            },
          ],
        },
      },
    };

    if (process.env['CLOUD_RUNNER_MINIKUBE']) {
      job.spec.template.spec.volumes[0] = {
        name: 'build-mount',
        hostPath: {
          path: `/data`,
          type: `Directory`,
        },
      };
    }

    // Set ephemeral-storage request to a reasonable value to prevent evictions
    // For tests, don't set a request (or use minimal 128Mi) since k3d nodes have very limited disk space
    // Kubernetes will use whatever is available without a request, which is better for constrained environments
    // For production, use 2Gi to allow for larger builds
    // The node needs some free space headroom, so requesting too much causes evictions
    // With node at 96% usage and only ~2.7GB free, we can't request much without triggering evictions
    if (process.env['cloudRunnerTests'] !== 'true') {
      // Only set ephemeral-storage request for production builds
      job.spec.template.spec.containers[0].resources.requests[`ephemeral-storage`] = '2Gi';
    }
    // For tests, don't set ephemeral-storage request - let Kubernetes use available space

    return job;
  }
}
export default KubernetesJobSpecFactory;
