import * as k8s from '@kubernetes/client-node';
import { BuildParameters } from '../../..';
import * as core from '@actions/core';
import { ProviderInterface } from '../provider-interface';
import CloudRunnerSecret from '../../options/cloud-runner-secret';
import KubernetesStorage from './kubernetes-storage';
import CloudRunnerEnvironmentVariable from '../../options/cloud-runner-environment-variable';
import KubernetesTaskRunner from './kubernetes-task-runner';
import KubernetesSecret from './kubernetes-secret';
import KubernetesJobSpecFactory from './kubernetes-job-spec-factory';
import KubernetesServiceAccount from './kubernetes-service-account';
import CloudRunnerLogger from '../../services/core/cloud-runner-logger';
import { CoreV1Api } from '@kubernetes/client-node';
import CloudRunner from '../../cloud-runner';
import { ProviderResource } from '../provider-resource';
import { ProviderWorkflow } from '../provider-workflow';
import { RemoteClientLogger } from '../../remote-client/remote-client-logger';
import { KubernetesRole } from './kubernetes-role';
import { CloudRunnerSystem } from '../../services/core/cloud-runner-system';

class Kubernetes implements ProviderInterface {
  public static Instance: Kubernetes;
  public kubeConfig!: k8s.KubeConfig;
  public kubeClient!: k8s.CoreV1Api;
  public kubeClientApps!: k8s.AppsV1Api;
  public kubeClientBatch!: k8s.BatchV1Api;
  public rbacAuthorizationV1Api!: k8s.RbacAuthorizationV1Api;
  public buildGuid: string = '';
  public buildParameters!: BuildParameters;
  public pvcName: string = '';
  public secretName: string = '';
  public jobName: string = '';
  public namespace!: string;
  public podName: string = '';
  public containerName: string = '';
  public cleanupCronJobName: string = '';
  public serviceAccountName: string = '';
  public ip: string = '';

  constructor(buildParameters: BuildParameters) {
    Kubernetes.Instance = this;
    this.kubeConfig = new k8s.KubeConfig();
    this.kubeConfig.loadFromDefault();
    this.kubeClient = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.kubeClientApps = this.kubeConfig.makeApiClient(k8s.AppsV1Api);
    this.kubeClientBatch = this.kubeConfig.makeApiClient(k8s.BatchV1Api);
    this.rbacAuthorizationV1Api = this.kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api);
    this.namespace = buildParameters.containerNamespace ? buildParameters.containerNamespace : 'default';
    CloudRunnerLogger.log('Loaded default Kubernetes configuration for this environment');
  }

  async PushLogUpdate(logs: string) {
    // push logs to nginx file server via 'LOG_SERVICE_IP' env var
    const ip = process.env[`LOG_SERVICE_IP`];
    if (ip === undefined) {
      RemoteClientLogger.logWarning(`LOG_SERVICE_IP not set, skipping log push`);

      return;
    }
    const url = `http://${ip}/api/log`;
    RemoteClientLogger.log(`Pushing logs to ${url}`);

    // logs to base64
    logs = Buffer.from(logs).toString('base64');
    const response = await CloudRunnerSystem.Run(`curl -X POST -d "${logs}" ${url}`, false, true);
    RemoteClientLogger.log(`Pushed logs to ${url} ${response}`);
  }

  async listResources(): Promise<ProviderResource[]> {
    const pods = await this.kubeClient.listNamespacedPod(this.namespace);
    const serviceAccounts = await this.kubeClient.listNamespacedServiceAccount(this.namespace);
    const secrets = await this.kubeClient.listNamespacedSecret(this.namespace);
    const jobs = await this.kubeClientBatch.listNamespacedJob(this.namespace);

    return [
      ...pods.body.items.map((x) => {
        return { Name: x.metadata?.name || `` };
      }),
      ...serviceAccounts.body.items.map((x) => {
        return { Name: x.metadata?.name || `` };
      }),
      ...secrets.body.items.map((x) => {
        return { Name: x.metadata?.name || `` };
      }),
      ...jobs.body.items.map((x) => {
        return { Name: x.metadata?.name || `` };
      }),
    ];
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
    return new Promise((result) => result(``));
  }
  public async setupWorkflow(
    buildGuid: string,
    buildParameters: BuildParameters,
    // eslint-disable-next-line no-unused-vars
    branchName: string,
    // eslint-disable-next-line no-unused-vars
    defaultSecretsArray: { ParameterKey: string; EnvironmentVariable: string; ParameterValue: string }[],
  ) {
    try {
      this.buildParameters = buildParameters;
      this.cleanupCronJobName = `unity-builder-cronjob-${buildParameters.buildGuid}`;
      this.serviceAccountName = `service-account-${buildParameters.buildGuid}`;

      await KubernetesServiceAccount.createServiceAccount(this.serviceAccountName, this.namespace, this.kubeClient);
    } catch (error) {
      throw error;
    }
  }

  async runTaskInWorkflow(
    buildGuid: string,
    image: string,
    commands: string,
    mountdir: string,
    workingdir: string,
    environment: CloudRunnerEnvironmentVariable[],
    secrets: CloudRunnerSecret[],
  ): Promise<string> {
    try {
      CloudRunnerLogger.log('Cloud Runner K8s workflow!');

      // Setup
      const id =
        BuildParameters && BuildParameters.shouldUseRetainedWorkspaceMode(this.buildParameters)
          ? CloudRunner.lockedWorkspace
          : this.buildParameters.buildGuid;
      this.pvcName = `unity-builder-pvc-${id}`;
      await KubernetesStorage.createPersistentVolumeClaim(
        this.buildParameters,
        this.pvcName,
        this.kubeClient,
        this.namespace,
      );
      this.buildGuid = buildGuid;
      this.secretName = `build-credentials-${this.buildGuid}`;
      this.jobName = `unity-builder-job-${this.buildGuid}`;
      this.containerName = `main`;
      await KubernetesSecret.createSecret(secrets, this.secretName, this.namespace, this.kubeClient);

      // For tests, clean up old images before creating job to free space for image pull
      // IMPORTANT: Preserve the Unity image to avoid re-pulling it
      if (process.env['cloudRunnerTests'] === 'true') {
        try {
          CloudRunnerLogger.log('Cleaning up old images in k3d node before pulling new image...');
          const { CloudRunnerSystem } = await import('../../services/core/cloud-runner-system');

          // Extract image name without tag for matching
          const imageName = image.split(':')[0];
          const imageTag = image.split(':')[1] || 'latest';

          // More targeted cleanup: remove stopped containers only
          // IMPORTANT: Do NOT remove images - preserve Unity image to avoid re-pulling the 3.9GB image
          // Strategy: Only remove containers, never touch images (safest approach)
          const cleanupCommands = [
            // Remove all stopped containers (this frees runtime space but keeps images)
            'docker exec k3d-unity-builder-agent-0 sh -c "crictl rm --all 2>/dev/null || true" || true',
            'docker exec k3d-unity-builder-server-0 sh -c "crictl rm --all 2>/dev/null || true" || true',
            // DO NOT remove images - preserve everything including Unity image
            // Removing images risks removing the Unity image which causes "no space left" errors
          ];

          for (const cmd of cleanupCommands) {
            try {
              await CloudRunnerSystem.Run(cmd, true, true);
            } catch (cmdError) {
              // Ignore individual command failures
              CloudRunnerLogger.log(`Cleanup command failed (non-fatal): ${cmdError}`);
            }
          }

          // Verify Unity image is cached on the AGENT node (where pods run)
          // This is critical - if the image isn't on the agent node, pods will try to pull it
          let unityImageCached = false;
          try {
            const unityImageCheckAgent = await CloudRunnerSystem.Run(
              `docker exec k3d-unity-builder-agent-0 sh -c "crictl images | grep -q unityci/editor && echo 'found' || echo 'not found'" || echo 'not found'`,
              true,
              true,
            );
            unityImageCached = unityImageCheckAgent.includes('found');
            CloudRunnerLogger.log(
              `Unity image cache status on agent node: ${unityImageCached ? 'CACHED' : 'NOT CACHED'}`,
            );
            
            if (!unityImageCached) {
              // Check if it's on the server node (might need to be copied)
              const unityImageCheckServer = await CloudRunnerSystem.Run(
                `docker exec k3d-unity-builder-server-0 sh -c "crictl images | grep -q unityci/editor && echo 'found' || echo 'not found'" || echo 'not found'`,
                true,
                true,
              );
              CloudRunnerLogger.log(
                `Unity image cache status on server node: ${unityImageCheckServer.includes('found') ? 'CACHED' : 'NOT CACHED'}`,
              );
              
              // Check available disk space
              const diskCheck = await CloudRunnerSystem.Run(
                'docker exec k3d-unity-builder-agent-0 sh -c "df -h /var/lib/rancher/k3s 2>/dev/null | tail -1 | awk \'{print $4}\' || df -h / 2>/dev/null | tail -1 | awk \'{print $4}\' || echo unknown" || echo unknown',
                true,
                true,
              );
              CloudRunnerLogger.log(`Available disk space on agent node: ${diskCheck.trim()}`);
              
              // Unity image is ~3.9GB, so we need at least 4-5GB free
              // If we have less than 4GB, warn that pull will likely fail
              const availableSpaceStr = diskCheck.trim().toLowerCase();
              if (availableSpaceStr.includes('g')) {
                const availableGB = parseFloat(availableSpaceStr);
                if (availableGB < 4) {
                  CloudRunnerLogger.logWarning(
                    `WARNING: Unity image not cached and only ${availableGB}GB available. Image pull (3.9GB) will likely fail due to disk pressure.`,
                  );
                }
              }
            }
          } catch {
            // Ignore check failures - continue and hope image is cached
            CloudRunnerLogger.logWarning('Failed to check Unity image cache status');
          }
        } catch (cleanupError) {
          CloudRunnerLogger.logWarning(`Failed to cleanup images before job creation: ${cleanupError}`);
          // Continue anyway - image might already be cached
        }
      }

      let output = '';
      try {
        // Before creating the job, verify we have the Unity image cached or enough space to pull it
        if (process.env['cloudRunnerTests'] === 'true' && image.includes('unityci/editor')) {
          try {
            const { CloudRunnerSystem } = await import('../../services/core/cloud-runner-system');
            const imageCheck = await CloudRunnerSystem.Run(
              `docker exec k3d-unity-builder-agent-0 sh -c "crictl images | grep -q unityci/editor && echo 'cached' || echo 'not_cached'" || echo 'not_cached'`,
              true,
              true,
            );
            
            if (imageCheck.includes('not_cached')) {
              // Image not cached - check if we have enough space to pull it
              const diskInfo = await CloudRunnerSystem.Run(
                'docker exec k3d-unity-builder-agent-0 sh -c "df -h /var/lib/rancher/k3s 2>/dev/null | tail -1 || df -h / 2>/dev/null | tail -1 || echo unknown" || echo unknown',
                true,
                true,
              );
              CloudRunnerLogger.logWarning(
                `Unity image not cached on agent node. Disk info: ${diskInfo.trim()}. Pod will attempt to pull image (3.9GB) which may fail due to disk pressure.`,
              );
            } else {
              CloudRunnerLogger.log('Unity image is cached on agent node - pod should start without pulling');
            }
          } catch (checkError) {
            // Ignore check errors - continue with job creation
            CloudRunnerLogger.logWarning(`Failed to verify Unity image cache: ${checkError}`);
          }
        }
        
        CloudRunnerLogger.log('Job does not exist');
        await this.createJob(commands, image, mountdir, workingdir, environment, secrets);
        CloudRunnerLogger.log('Watching pod until running');
        await KubernetesTaskRunner.watchUntilPodRunning(this.kubeClient, this.podName, this.namespace);

        CloudRunnerLogger.log('Pod is running');
        output += await KubernetesTaskRunner.runTask(
          this.kubeConfig,
          this.kubeClient,
          this.jobName,
          this.podName,
          this.containerName,
          this.namespace,
        );
      } catch (error: any) {
        CloudRunnerLogger.log(`error running k8s workflow ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        CloudRunnerLogger.log(
          JSON.stringify(
            (await this.kubeClient.listNamespacedEvent(this.namespace)).body.items
              .map((x) => {
                return {
                  message: x.message || ``,
                  name: x.metadata.name || ``,
                  reason: x.reason || ``,
                };
              })
              .filter((x) => x.name.includes(this.podName)),
            undefined,
            4,
          ),
        );
        await this.cleanupTaskResources();
        throw error;
      }

      await this.cleanupTaskResources();

      return output;
    } catch (error) {
      CloudRunnerLogger.log('Running job failed');
      core.error(JSON.stringify(error, undefined, 4));

      // await this.cleanupTaskResources();
      throw error;
    }
  }

  private async createJob(
    commands: string,
    image: string,
    mountdir: string,
    workingdir: string,
    environment: CloudRunnerEnvironmentVariable[],
    secrets: CloudRunnerSecret[],
  ) {
    await this.createNamespacedJob(commands, image, mountdir, workingdir, environment, secrets);
    const find = await Kubernetes.findPodFromJob(this.kubeClient, this.jobName, this.namespace);
    this.setPodNameAndContainerName(find);
  }

  private async doesJobExist(name: string) {
    const jobs = await this.kubeClientBatch.listNamespacedJob(this.namespace);

    return jobs.body.items.some((x) => x.metadata?.name === name);
  }

  private async doesFailedJobExist() {
    const podStatus = await this.kubeClient.readNamespacedPodStatus(this.podName, this.namespace);

    return podStatus.body.status?.phase === `Failed`;
  }

  private async createNamespacedJob(
    commands: string,
    image: string,
    mountdir: string,
    workingdir: string,
    environment: CloudRunnerEnvironmentVariable[],
    secrets: CloudRunnerSecret[],
  ) {
    for (let index = 0; index < 3; index++) {
      try {
        const jobSpec = KubernetesJobSpecFactory.getJobSpec(
          commands,
          image,
          mountdir,
          workingdir,
          environment,
          secrets,
          this.buildGuid,
          this.buildParameters,
          this.secretName,
          this.pvcName,
          this.jobName,
          k8s,
          this.containerName,
          this.ip,
        );
        await new Promise((promise) => setTimeout(promise, 15000));

        // await KubernetesRole.createRole(this.serviceAccountName, this.namespace, this.rbacAuthorizationV1Api);

        const result = await this.kubeClientBatch.createNamespacedJob(this.namespace, jobSpec);
        CloudRunnerLogger.log(`Build job created`);
        await new Promise((promise) => setTimeout(promise, 5000));
        CloudRunnerLogger.log('Job created');

        return result.body.metadata?.name;
      } catch (error) {
        CloudRunnerLogger.log(`Error occured creating job: ${error}`);
        throw error;
      }
    }
  }

  setPodNameAndContainerName(pod: k8s.V1Pod) {
    this.podName = pod.metadata?.name || '';
    this.containerName = pod.status?.containerStatuses?.[0].name || this.containerName;
  }

  async cleanupTaskResources() {
    CloudRunnerLogger.log('cleaning up');
    try {
      await this.kubeClientBatch.deleteNamespacedJob(this.jobName, this.namespace);
      await this.kubeClient.deleteNamespacedPod(this.podName, this.namespace);
      await KubernetesRole.deleteRole(this.serviceAccountName, this.namespace, this.rbacAuthorizationV1Api);
    } catch (error: any) {
      CloudRunnerLogger.log(`Failed to cleanup`);
      if (error.response.body.reason !== `NotFound`) {
        CloudRunnerLogger.log(`Wasn't a not found error: ${error.response.body.reason}`);
        throw error;
      }
    }
    try {
      await this.kubeClient.deleteNamespacedSecret(this.secretName, this.namespace);
    } catch (error: any) {
      CloudRunnerLogger.log(`Failed to cleanup secret`);
      CloudRunnerLogger.log(error.response.body.reason);
    }
    CloudRunnerLogger.log('cleaned up Secret, Job and Pod');
    CloudRunnerLogger.log('cleaning up finished');
  }

  async cleanupWorkflow(
    buildParameters: BuildParameters,
    // eslint-disable-next-line no-unused-vars
    branchName: string,
    // eslint-disable-next-line no-unused-vars
    defaultSecretsArray: { ParameterKey: string; EnvironmentVariable: string; ParameterValue: string }[],
  ) {
    if (BuildParameters && BuildParameters.shouldUseRetainedWorkspaceMode(buildParameters)) {
      return;
    }
    CloudRunnerLogger.log(`deleting PVC`);

    try {
      await this.kubeClient.deleteNamespacedPersistentVolumeClaim(this.pvcName, this.namespace);
      await this.kubeClient.deleteNamespacedServiceAccount(this.serviceAccountName, this.namespace);
      CloudRunnerLogger.log('cleaned up PVC and Service Account');
    } catch (error: any) {
      CloudRunnerLogger.log(`Cleanup failed ${JSON.stringify(error, undefined, 4)}`);
      throw error;
    }
  }

  static async findPodFromJob(kubeClient: CoreV1Api, jobName: string, namespace: string) {
    const namespacedPods = await kubeClient.listNamespacedPod(namespace);
    const pod = namespacedPods.body.items.find((x) => x.metadata?.labels?.['job-name'] === jobName);
    if (pod === undefined) {
      throw new Error("pod with job-name label doesn't exist");
    }

    return pod;
  }
}
export default Kubernetes;
