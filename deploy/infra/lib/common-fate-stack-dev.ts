import * as cdk from "aws-cdk-lib";

import { Construct } from "constructs";
import { AccessHandler } from "./constructs/access-handler";
import { AppBackend } from "./constructs/app-backend";
import { AppFrontend } from "./constructs/app-frontend";
import { WebUserPool } from "./constructs/app-user-pool";
import { Database } from "./constructs/database";
import * as kms from "aws-cdk-lib/aws-kms";

import { EventBus } from "./constructs/events";
import { DevEnvironmentConfig } from "./helpers/dev-accounts";
import { generateOutputs } from "./helpers/outputs";
import { IdentityProviderTypes } from "./helpers/registry";
import { Governance } from "./constructs/governance";
import { TargetGroupGranter } from "./constructs/targetgroup-granter";
import { CfnCondition } from "aws-cdk-lib";
import { VpcConfig } from "./helpers/base-lambda";

interface Props extends cdk.StackProps {
  stage: string;
  cognitoDomainPrefix: string;
  idpType: IdentityProviderTypes;
  providerConfig: string;
  samlMetadataUrl: string;
  samlMetadata: string;
  remoteConfigUrl: string;
  remoteConfigHeaders: string;
  devConfig: DevEnvironmentConfig | null;
  notificationsConfiguration: string;
  identityProviderSyncConfiguration: string;
  adminGroupId: string;
  cloudfrontWafAclArn: string;
  apiGatewayWafAclArn: string;
  analyticsDisabled: string;
  analyticsUrl: string;
  analyticsLogLevel: string;
  analyticsDeploymentStage: string;
  shouldRunCronHealthCheckCacheSync: boolean;
  identityGroupFilter: string;
  idpSyncTimeoutSeconds: number;
  idpSyncSchedule: string;
  idpSyncMemory: number;
  autoApprovalLambdaARN: string;
  subnetIds: string;
  securityGroups: string;
}

export class CommonFateStackDev extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const {
      stage,
      cognitoDomainPrefix,
      idpType,
      samlMetadataUrl,
      samlMetadata,
      devConfig,
      adminGroupId,
      notificationsConfiguration,
      identityProviderSyncConfiguration,
      remoteConfigUrl,
      remoteConfigHeaders,
      cloudfrontWafAclArn,
      apiGatewayWafAclArn,
      analyticsDisabled,
      analyticsUrl,
      analyticsLogLevel,
      analyticsDeploymentStage,
      identityGroupFilter,
      idpSyncTimeoutSeconds,
      idpSyncSchedule,
      idpSyncMemory,
      autoApprovalLambdaARN,
    } = props;
    const appName = `common-fate-${stage}`;
    const attachLambdaToVpcCondition = new CfnCondition(
      this,
      "AttachLambdaToVpcCondition",
      {
        expression: cdk.Fn.conditionAnd(
          cdk.Fn.conditionNot(cdk.Fn.conditionEquals(props.subnetIds, "")),
          cdk.Fn.conditionNot(cdk.Fn.conditionEquals(props.securityGroups, ""))
        ),
      }
    );

    const vpcConfig: VpcConfig = {
      subnetIds: cdk.Fn.conditionIf(attachLambdaToVpcCondition.logicalId, props.subnetIds.split(","), []),
      securityGroupIds: cdk.Fn.conditionIf(attachLambdaToVpcCondition.logicalId, props.securityGroups.split(","), []),
    }


    const db = new Database(this, "Database", {
      appName,
    });

    const cdn = new AppFrontend(this, "Frontend", {
      appName,
      // this will be unique for dev deployments
      stableName: appName,
    }).withDevCDN(stage, devConfig, cloudfrontWafAclArn);

    const userPool = new WebUserPool(this, "WebUserPool", {
      appName: appName,
      domainPrefix: cognitoDomainPrefix,
      frontendUrl: "https://" + cdn.getDomainName(),
      callbackUrls: cdn.getDevCallbackUrls(),
      idpType: idpType,
      samlMetadataUrl: samlMetadataUrl,
      samlMetadata: samlMetadata,
      devConfig,
    });

    const events = new EventBus(this, "EventBus", {
      appName: appName,
    });

    const accessHandler = new AccessHandler(this, "AccessHandler", {
      appName: appName,
      eventBus: events.getEventBus(),
      eventBusSourceName: events.getEventBusSourceName(),
      providerConfig: props.providerConfig,
      vpcConfig: vpcConfig,
      remoteConfigUrl,
      remoteConfigHeaders,
    });

    //KMS key is used in governance api as well as appBackend - both for tokinization for ddb use
    const kmsKey = new kms.Key(this, "PaginationKMSKey", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
      enableKeyRotation: true,
      description:
        "Used for encrypting and decrypting pagination tokens for Common Fate",
    });

    const governance = new Governance(this, "Governance", {
      appName: appName,
      kmsKey: kmsKey,

      accessHandler: accessHandler,

      providerConfig: props.providerConfig,

      dynamoTable: db.getTable(),
      vpcConfig: vpcConfig,
    });
    const targetGroupGranter = new TargetGroupGranter(
      this,
      "TargetGroupGranter",
      {
        eventBus: events.getEventBus(),
        eventBusSourceName: events.getEventBusSourceName(),
        dynamoTable: db.getTable(),
        vpcConfig: vpcConfig,
      }
    );
    const appBackend = new AppBackend(this, "API", {
      appName: appName,
      userPool: userPool,
      frontendUrl: "https://" + cdn.getDomainName(),
      accessHandler: accessHandler,
      governanceHandler: governance,
      eventBus: events.getEventBus(),
      eventBusSourceName: events.getEventBusSourceName(),
      adminGroupId,
      providerConfig: props.providerConfig,
      identityProviderSyncConfiguration: identityProviderSyncConfiguration,
      notificationsConfiguration: notificationsConfiguration,
      deploymentSuffix: stage,
      dynamoTable: db.getTable(),
      remoteConfigUrl,
      remoteConfigHeaders,
      apiGatewayWafAclArn,
      analyticsDisabled,
      analyticsUrl,
      analyticsLogLevel,
      analyticsDeploymentStage,
      kmsKey: kmsKey,
      idpSyncMemory: idpSyncMemory,
      idpSyncSchedule: idpSyncSchedule,
      idpSyncTimeoutSeconds: idpSyncTimeoutSeconds,
      shouldRunCronHealthCheckCacheSync:
        props.shouldRunCronHealthCheckCacheSync || false,
      targetGroupGranter: targetGroupGranter,
      identityGroupFilter,
      autoApprovalLambdaARN: autoApprovalLambdaARN,
      vpcConfig: vpcConfig,
    });

    /* Outputs */
    generateOutputs(this, {
      CognitoClientID: userPool.getUserPoolClientId(),
      CloudFrontDomain: cdn.getCloudFrontDomain(),
      FrontendDomainOutput: cdn.getDomainName(),
      CloudFrontDistributionID: cdn.getDistributionId(),
      S3BucketName: cdn.getBucketName(),
      UserPoolID: userPool.getUserPoolId(),
      UserPoolDomain: userPool.getUserPoolLoginFQDN(),
      APIURL: appBackend.getRestApiURL(),
      WebhookURL: appBackend.getWebhookApiURL(),
      GovernanceURL: governance.getGovernanceApiURL(),
      APILogGroupName: appBackend.getLogGroupName(),
      WebhookLogGroupName: appBackend.getWebhookLogGroupName(),
      IDPSyncLogGroupName: appBackend.getIdpSync().getLogGroupName(),
      AccessHandlerLogGroupName: accessHandler.getLogGroupName(),
      EventBusLogGroupName: events.getLogGroupName(),
      EventsHandlerLogGroupName: appBackend.getEventHandler().getLogGroupName(),
      GranterLogGroupName: accessHandler.getGranter().getLogGroupName(),
      SlackNotifierLogGroupName: appBackend
        .getNotifiers()
        .getSlackLogGroupName(),
      GovernanceAPILogGroupName: governance.getGovernanceLogGroupName(),
      DynamoDBTable: appBackend.getDynamoTableName(),
      GranterStateMachineArn: accessHandler.getGranter().getStateMachineARN(),
      EventBusArn: events.getEventBus().eventBusArn,
      EventBusSource: events.getEventBusSourceName(),
      IdpSyncFunctionName: appBackend.getIdpSync().getFunctionName(),
      SAMLIdentityProviderName:
        userPool.getSamlUserPoolClient()?.getUserPoolName() || "",
      Region: this.region,
      PaginationKMSKeyARN: appBackend.getKmsKeyArn(),
      AccessHandlerExecutionRoleARN:
        accessHandler.getAccessHandlerExecutionRoleArn(),
      CacheSyncLogGroupName: appBackend.getCacheSync().getLogGroupName(),
      IDPSyncExecutionRoleARN: appBackend.getIdpSync().getExecutionRoleArn(),
      RestAPIExecutionRoleARN: appBackend.getExecutionRoleArn(),
      CacheSyncFunctionName: appBackend.getCacheSync().getFunctionName(),
      CLIAppClientID: userPool.getCLIAppClient().userPoolClientId,
      HealthcheckFunctionName: appBackend.getHealthChecker().getFunctionName(),
      HealthcheckLogGroupName: appBackend.getHealthChecker().getLogGroupName(),
      GranterV2StateMachineArn: targetGroupGranter.getStateMachineARN(),
    });
  }
}
