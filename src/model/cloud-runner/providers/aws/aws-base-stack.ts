import CloudRunnerLogger from '../../services/core/cloud-runner-logger';
import CloudRunnerOptions from '../../options/cloud-runner-options';
import * as core from '@actions/core';
import {
  CloudFormation,
  CreateStackCommand,
  // eslint-disable-next-line import/named
  CreateStackCommandInput,
  DescribeStacksCommand,
  // eslint-disable-next-line import/named
  DescribeStacksCommandInput,
  ListStacksCommand,
  // eslint-disable-next-line import/named
  Parameter,
  UpdateStackCommand,
  // eslint-disable-next-line import/named
  UpdateStackCommandInput,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
} from '@aws-sdk/client-cloudformation';
import { BaseStackFormation } from './cloud-formations/base-stack-formation';
import crypto from 'node:crypto';

const LOCALSTACK_ENDPOINT_PATTERN = /localstack|localhost|127\.0\.0\.1/i;
const LOCALSTACK_WAIT_TIME_SECONDS = 600;
const DEFAULT_STACK_WAIT_TIME_SECONDS = 200;

function detectLocalStackEnvironment(): boolean {
  const endpoints = [
    process.env.AWS_ENDPOINT,
    process.env.AWS_S3_ENDPOINT,
    process.env.AWS_CLOUD_FORMATION_ENDPOINT,
    process.env.AWS_ECS_ENDPOINT,
    process.env.AWS_KINESIS_ENDPOINT,
    process.env.AWS_CLOUD_WATCH_LOGS_ENDPOINT,
    CloudRunnerOptions.awsEndpoint,
    CloudRunnerOptions.awsS3Endpoint,
    CloudRunnerOptions.awsCloudFormationEndpoint,
    CloudRunnerOptions.awsEcsEndpoint,
    CloudRunnerOptions.awsKinesisEndpoint,
    CloudRunnerOptions.awsCloudWatchLogsEndpoint,
  ]
    .filter((endpoint) => endpoint !== undefined && endpoint !== '')
    .join(' ');
  return LOCALSTACK_ENDPOINT_PATTERN.test(endpoints);
}

function determineStackWaitTime(isLocalStack: boolean): number {
  const overrideValue = Number(process.env.CLOUD_RUNNER_AWS_STACK_WAIT_TIME ?? '');
  if (!Number.isNaN(overrideValue) && overrideValue > 0) {
    return overrideValue;
  }

  return isLocalStack ? LOCALSTACK_WAIT_TIME_SECONDS : DEFAULT_STACK_WAIT_TIME_SECONDS;
}

export class AWSBaseStack {
  constructor(baseStackName: string) {
    this.baseStackName = baseStackName;
  }
  private baseStackName: string;

  async setupBaseStack(CF: CloudFormation) {
    const baseStackName = this.baseStackName;
    const isLocalStack = detectLocalStackEnvironment();
    const stackWaitTimeSeconds = determineStackWaitTime(isLocalStack);

    if (isLocalStack) {
      CloudRunnerLogger.log(
        `LocalStack endpoints detected; will wait up to ${stackWaitTimeSeconds}s for CloudFormation transitions`,
      );
    }

    const baseStack = BaseStackFormation.formation;

    // Cloud Formation Input
    const describeStackInput: DescribeStacksCommandInput = {
      StackName: baseStackName,
    };
    const parametersWithoutHash: Parameter[] = [{ ParameterKey: 'EnvironmentName', ParameterValue: baseStackName }];
    const parametersHash = crypto
      .createHash('md5')
      .update(baseStack + JSON.stringify(parametersWithoutHash))
      .digest('hex');
    const parameters: Parameter[] = [
      ...parametersWithoutHash,
      ...[{ ParameterKey: 'Version', ParameterValue: parametersHash }],
    ];
    const updateInput: UpdateStackCommandInput = {
      StackName: baseStackName,
      TemplateBody: baseStack,
      Parameters: parameters,
      Capabilities: ['CAPABILITY_IAM'],
    };
    const createStackInput: CreateStackCommandInput = {
      StackName: baseStackName,
      TemplateBody: baseStack,
      Parameters: parameters,
      Capabilities: ['CAPABILITY_IAM'],
    };

    const stacks = await CF.send(
      new ListStacksCommand({
        StackStatusFilter: ['CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE', 'CREATE_COMPLETE', 'ROLLBACK_COMPLETE'],
      }),
    );
    const stackNames = stacks.StackSummaries?.map((x) => x.StackName) || [];
    const stackExists: boolean = stackNames.includes(baseStackName);
    const describeStack = async () => {
      return await CF.send(new DescribeStacksCommand(describeStackInput));
    };
    try {
      if (!stackExists) {
        CloudRunnerLogger.log(`${baseStackName} stack does not exist (${JSON.stringify(stackNames)})`);
        let created = false;
        try {
          await CF.send(new CreateStackCommand(createStackInput));
          created = true;
        } catch (error: any) {
          const message = `${error?.name ?? ''} ${error?.message ?? ''}`;
          if (message.includes('AlreadyExistsException')) {
            CloudRunnerLogger.log(`Base stack already exists, continuing with describe`);
          } else {
            throw error;
          }
        }
        if (created) {
          CloudRunnerLogger.log(`created stack (version: ${parametersHash})`);
        }
      }
      const CFState = await describeStack();
      let stack = CFState.Stacks?.[0];
      if (!stack) {
        throw new Error(`Base stack doesn't exist, even after creation, stackExists check: ${stackExists}`);
      }
      const stackVersion = stack.Parameters?.find((x) => x.ParameterKey === 'Version')?.ParameterValue;

      if (stack.StackStatus === 'CREATE_IN_PROGRESS') {
        CloudRunnerLogger.log(
          `Waiting up to ${stackWaitTimeSeconds}s for '${baseStackName}' CloudFormation creation to finish`,
        );
        await waitUntilStackCreateComplete(
          {
            client: CF,
            maxWaitTime: stackWaitTimeSeconds,
          },
          describeStackInput,
        );
      }

      if (stackExists) {
        CloudRunnerLogger.log(`Base stack exists (version: ${stackVersion}, local version: ${parametersHash})`);
        if (parametersHash !== stackVersion) {
          CloudRunnerLogger.log(`Attempting update of base stack`);
          try {
            await CF.send(new UpdateStackCommand(updateInput));
          } catch (error: any) {
            if (error['message'].includes('No updates are to be performed')) {
              CloudRunnerLogger.log(`No updates are to be performed`);
            } else {
              CloudRunnerLogger.log(`Update Failed (Stack name: ${baseStackName})`);
              CloudRunnerLogger.log(error['message']);
            }
            CloudRunnerLogger.log(`Continuing...`);
          }
        } else {
          CloudRunnerLogger.log(`No update required`);
        }
        stack = (await describeStack()).Stacks?.[0];
        if (!stack) {
          throw new Error(
            `Base stack doesn't exist, even after updating and creation, stackExists check: ${stackExists}`,
          );
        }
        if (stack.StackStatus === 'UPDATE_IN_PROGRESS') {
          CloudRunnerLogger.log(
            `Waiting up to ${stackWaitTimeSeconds}s for '${baseStackName}' CloudFormation update to finish`,
          );
          await waitUntilStackUpdateComplete(
            {
              client: CF,
              maxWaitTime: stackWaitTimeSeconds,
            },
            describeStackInput,
          );
        }
      }
      CloudRunnerLogger.log('base stack is now ready');
    } catch (error) {
      core.error(JSON.stringify(await describeStack(), undefined, 4));
      throw error;
    }
  }
}
