import CloudRunnerLogger from '../../services/core/cloud-runner-logger';
import { CoreV1Api } from '@kubernetes/client-node';
class KubernetesPods {
  public static async IsPodRunning(podName: string, namespace: string, kubeClient: CoreV1Api) {
    const pods = (await kubeClient.listNamespacedPod(namespace)).body.items.filter((x) => podName === x.metadata?.name);
    const running = pods.length > 0 && (pods[0].status?.phase === `Running` || pods[0].status?.phase === `Pending`);
    const phase = pods[0]?.status?.phase || 'undefined status';
    CloudRunnerLogger.log(`Getting pod status: ${phase}`);
    if (phase === `Failed`) {
      const pod = pods[0];
      const containerStatuses = pod.status?.containerStatuses || [];
      const conditions = pod.status?.conditions || [];
      const events = (await kubeClient.listNamespacedEvent(namespace)).body.items
        .filter((x) => x.involvedObject?.name === podName)
        .map((x) => ({
          message: x.message || '',
          reason: x.reason || '',
          type: x.type || '',
        }));

      const errorDetails: string[] = [];
      errorDetails.push(`Pod: ${podName}`);
      errorDetails.push(`Phase: ${phase}`);
      
      if (conditions.length > 0) {
        errorDetails.push(`Conditions: ${JSON.stringify(conditions.map(c => ({ type: c.type, status: c.status, reason: c.reason, message: c.message })), undefined, 2)}`);
      }

      if (containerStatuses.length > 0) {
        containerStatuses.forEach((cs, idx) => {
          if (cs.state?.waiting) {
            errorDetails.push(`Container ${idx} (${cs.name}) waiting: ${cs.state.waiting.reason} - ${cs.state.waiting.message || ''}`);
          }
          if (cs.state?.terminated) {
            errorDetails.push(`Container ${idx} (${cs.name}) terminated: ${cs.state.terminated.reason} - ${cs.state.terminated.message || ''} (exit code: ${cs.state.terminated.exitCode})`);
          }
        });
      }

      if (events.length > 0) {
        errorDetails.push(`Recent events: ${JSON.stringify(events.slice(-5), undefined, 2)}`);
      }

      const errorMessage = `K8s pod failed\n${errorDetails.join('\n')}`;
      CloudRunnerLogger.log(errorMessage);
      throw new Error(errorMessage);
    }

    return running;
  }
  public static async GetPodStatus(podName: string, namespace: string, kubeClient: CoreV1Api) {
    const pods = (await kubeClient.listNamespacedPod(namespace)).body.items.find((x) => podName === x.metadata?.name);
    const phase = pods?.status?.phase || 'undefined status';

    return phase;
  }
}

export default KubernetesPods;
