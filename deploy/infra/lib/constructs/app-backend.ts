import * as cdk from "aws-cdk-lib";
import { CfnCondition, Duration, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { EventBus } from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { CfnWebACLAssociation } from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import * as path from "path";
import { AccessHandler } from "./access-handler";
import { WebUserPool } from "./app-user-pool";
import { CacheSync } from "./cache-sync";
import { EventHandler } from "./event-handler";
import { Governance } from "./governance";
import { IdpSync } from "./idp-sync";
import { Notifiers } from "./notifiers";
import { HealthChecker } from "./healthchecker";
import { TargetGroupGranter } from "./targetgroup-granter";
import {
  grantAssumeHandlerRole,
  grantAssumeIdentitySyncRole,
} from "../helpers/permissions";
import { BaseLambdaFunction, VpcConfig } from "../helpers/base-lambda";

interface Props {
  appName: string;
  userPool: WebUserPool;
  frontendUrl: string;
  accessHandler: AccessHandler;
  governanceHandler: Governance;
  eventBusSourceName: string;
  eventBus: EventBus;
  adminGroupId: string;
  providerConfig: string;
  notificationsConfiguration: string;
  identityProviderSyncConfiguration: string;
  deploymentSuffix: string;
  remoteConfigUrl: string;
  remoteConfigHeaders: string;
  analyticsDisabled: string;
  analyticsUrl: string;
  analyticsLogLevel: string;
  analyticsDeploymentStage: string;
  dynamoTable: dynamodb.Table;
  apiGatewayWafAclArn: string;
  kmsKey: cdk.aws_kms.Key;
  shouldRunCronHealthCheckCacheSync: boolean;
  idpSyncTimeoutSeconds: number;
  idpSyncSchedule: string;
  idpSyncMemory: number;
  targetGroupGranter: TargetGroupGranter;
  identityGroupFilter: string;
  autoApprovalLambdaARN: string;
  vpcConfig: VpcConfig;
}

export class AppBackend extends Construct {
  private readonly _appName: string;
  private _dynamoTable: dynamodb.Table;
  private _lambda: lambda.Function;
  private _apigateway: apigateway.LambdaRestApi;
  private _notifiers: Notifiers;
  private _eventHandler: EventHandler;
  private _idpSync: IdpSync;
  private _cacheSync: CacheSync;
  private _healthChecker: HealthChecker;
  private _KMSkey: cdk.aws_kms.Key;
  private _webhook: apigateway.Resource;
  private _webhookLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    this._appName = props.appName;

    this._dynamoTable = props.dynamoTable;

    this._KMSkey = props.kmsKey;

    // used to handle webhook events from third party integrations such as Slack
    this._webhookLambda = new lambda.Function(this, "WebhookHandlerFunction", {
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "..", "..", "..", "bin", "webhook.zip")
      ),
      timeout: Duration.seconds(20),
      runtime: lambda.Runtime.GO_1_X,
      handler: "webhook",
      environment: {
        COMMONFATE_TABLE_NAME: this._dynamoTable.tableName,
      },
    });

    this._dynamoTable.grantReadWriteData(this._webhookLambda);

    this._apigateway = new apigateway.RestApi(this, "RestAPI", {
      restApiName: this._appName,
    });

    //webhook

    const webhook = this._apigateway.root.addResource("webhook");
    const webhookv1 = webhook.addResource("v1");

    const webhookProxy = webhookv1.addResource("{proxy+}");
    webhookProxy.addMethod(
      "ANY",
      new apigateway.LambdaIntegration(this._webhookLambda, {
        allowTestInvoke: false,
      })
    );

    this._webhook = webhookv1;

    const code = lambda.Code.fromAsset(
      path.join(__dirname, "..", "..", "..", "..", "bin", "commonfate.zip")
    );

    this._lambda = new BaseLambdaFunction(this, "RestAPIHandlerFunction", {
      functionProps: {
        code,
        timeout: Duration.seconds(60),
        environment: {
          COMMONFATE_TABLE_NAME: this._dynamoTable.tableName,
          COMMONFATE_FRONTEND_URL: props.frontendUrl,
          COMMONFATE_COGNITO_USER_POOL_ID: props.userPool.getUserPoolId(),
          COMMONFATE_IDENTITY_PROVIDER: props.userPool.getIdpType(),
          COMMONFATE_ADMIN_GROUP: props.adminGroupId,
          COMMONFATE_MOCK_ACCESS_HANDLER: "false",
          COMMONFATE_ACCESS_HANDLER_URL: props.accessHandler.getApiUrl(),
          COMMONFATE_PROVIDER_CONFIG: props.providerConfig,
          // COMMONFATE_SENTRY_DSN: can be added here
          COMMONFATE_EVENT_BUS_ARN: props.eventBus.eventBusArn,
          COMMONFATE_EVENT_BUS_SOURCE: props.eventBusSourceName,
          COMMONFATE_IDENTITY_SETTINGS: props.identityProviderSyncConfiguration,
          COMMONFATE_PAGINATION_KMS_KEY_ARN: this._KMSkey.keyArn,
          COMMONFATE_ACCESS_HANDLER_EXECUTION_ROLE_ARN:
            props.accessHandler.getAccessHandlerExecutionRoleArn(),
          COMMONFATE_DEPLOYMENT_SUFFIX: props.deploymentSuffix,
          COMMONFATE_GRANTER_V2_STATE_MACHINE_ARN:
            props.targetGroupGranter.getStateMachineARN(),
          COMMONFATE_ACCESS_REMOTE_CONFIG_URL: props.remoteConfigUrl,
          COMMONFATE_REMOTE_CONFIG_HEADERS: props.remoteConfigHeaders,
          CF_ANALYTICS_DISABLED: props.analyticsDisabled,
          CF_ANALYTICS_URL: props.analyticsUrl,
          CF_ANALYTICS_LOG_LEVEL: props.analyticsLogLevel,
          CF_ANALYTICS_DEPLOYMENT_STAGE: props.analyticsDeploymentStage,
          COMMONFATE_IDENTITY_GROUP_FILTER: props.identityGroupFilter,
          COMMONFATE_AUTO_APPROVAL_LAMBDA_ARN: props.autoApprovalLambdaARN,
        },
        runtime: lambda.Runtime.GO_1_X,
        handler: "commonfate",
      },
      vpcConfig: props.vpcConfig,
    });

    this._KMSkey.grantEncryptDecrypt(this._lambda);

    // If an auto-approval lambda ARN is specified we need to grant permissions to RestAPIHandlerFunction to invoke it.
    if (props.autoApprovalLambdaARN.length !== 0) {
      this._lambda.addToRolePolicy(
          new PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [props.autoApprovalLambdaARN],
            actions: ['lambda:InvokeFunction'],
          })
      );
    }

    this._lambda.addToRolePolicy(
      new PolicyStatement({
        resources: [props.userPool.getUserPool().userPoolArn],
        actions: [
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:ListUsers",
          "cognito-idp:ListGroups",
          "cognito-idp:ListUsersInGroup",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListUserAuthEvents",
          "cognito-idp:AdminUserGlobalSignOut",
          "cognito-idp:DescribeUserPool",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:CreateGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
        ],
      })
    );
    this._lambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${Stack.of(this).region}:${
            Stack.of(this).account
          }:parameter/granted/secrets/identity/*`,
        ],
      })
    );

    // allow the Common Fate API to write SSM parameters as part of the guided setup workflow.
    this._lambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${Stack.of(this).region}:${
            Stack.of(this).account
          }:parameter/granted/providers/*`,
        ],
      })
    );

    this._lambda.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "states:StopExecution",
          "states:StartExecution",
          "states:DescribeExecution",
          "states:GetExecutionHistory",
          "states:StopExecution",
        ],
        // @TODO this should be specific to the v2 granter step function
        resources: ["*"],
      })
    );
    grantAssumeIdentitySyncRole(this._lambda);
    grantAssumeHandlerRole(this._lambda);
    const api = this._apigateway.root.addResource("api");
    const apiv1 = api.addResource("v1");

    const lambdaProxy = apiv1.addResource("{proxy+}");
    lambdaProxy.addMethod(
      "ANY",
      new apigateway.LambdaIntegration(this._lambda, {
        allowTestInvoke: false,
      }),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: new apigateway.CognitoUserPoolsAuthorizer(
          this,
          "Authorizer",
          {
            cognitoUserPools: [props.userPool.getUserPool()],
          }
        ),
      }
    );

    const ALLOWED_HEADERS = [
      "Content-Type",
      "X-Amz-Date",
      "X-Amz-Security-Token",
      "Authorization",
      "X-Api-Key",
      "X-Requested-With",
      "Accept",
      "Access-Control-Allow-Methods",
      "Access-Control-Allow-Origin",
      "Access-Control-Allow-Headers",
    ];

    const standardCorsMockIntegration = new apigateway.MockIntegration({
      integrationResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Headers": `'${ALLOWED_HEADERS.join(
              ","
            )}'`,
            "method.response.header.Access-Control-Allow-Origin": "'*'",
            "method.response.header.Access-Control-Allow-Credentials":
              "'false'",
            "method.response.header.Access-Control-Allow-Methods":
              "'OPTIONS,GET,PUT,POST,DELETE'",
          },
        },
      ],
      passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
      requestTemplates: {
        "application/json": '{"statusCode": 200}',
      },
    });

    const optionsMethodResponse = {
      statusCode: "200",
      responseModels: {
        "application/json": apigateway.Model.EMPTY_MODEL,
      },
      responseParameters: {
        "method.response.header.Access-Control-Allow-Headers": true,
        "method.response.header.Access-Control-Allow-Methods": true,
        "method.response.header.Access-Control-Allow-Credentials": true,
        "method.response.header.Access-Control-Allow-Origin": true,
      },
    };

    lambdaProxy.addMethod("OPTIONS", standardCorsMockIntegration, {
      authorizationType: apigateway.AuthorizationType.NONE,
      methodResponses: [optionsMethodResponse],
    });

    this._dynamoTable.grantReadWriteData(this._lambda);

    // Grant the Common Fate app access to invoke the access handler api
    this._lambda.addToRolePolicy(
      new PolicyStatement({
        resources: [props.accessHandler.getApiGateway().arnForExecuteApi()],
        actions: ["execute-api:Invoke"],
      })
    );
    props.eventBus.grantPutEventsTo(this._lambda);
    props.apiGatewayWafAclArn && this.wafAssociation(props.apiGatewayWafAclArn);
    this._eventHandler = new EventHandler(this, "EventHandler", {
      dynamoTable: this._dynamoTable,
      eventBus: props.eventBus,
      eventBusSourceName: props.eventBusSourceName,
      vpcConfig: props.vpcConfig,
    });
    this._notifiers = new Notifiers(this, "Notifiers", {
      dynamoTable: this._dynamoTable,
      eventBus: props.eventBus,
      eventBusSourceName: props.eventBusSourceName,
      frontendUrl: props.frontendUrl,
      userPool: props.userPool,
      notificationsConfig: props.notificationsConfiguration,
      remoteConfigUrl: props.remoteConfigUrl,
      remoteConfigHeaders: props.remoteConfigHeaders,
      vpcConfig: props.vpcConfig,
    });

    this._idpSync = new IdpSync(this, "IdpSync", {
      dynamoTable: this._dynamoTable,
      userPool: props.userPool,
      identityProviderSyncConfiguration:
        props.identityProviderSyncConfiguration,
      analyticsLogLevel: props.analyticsLogLevel,
      analyticsDeploymentStage: props.analyticsDeploymentStage,
      analyticsDisabled: props.analyticsDisabled,
      analyticsUrl: props.analyticsUrl,
      identityGroupFilter: props.identityGroupFilter,
      idpSyncMemory: props.idpSyncMemory,
      idpSyncSchedule: props.idpSyncSchedule,
      idpSyncTimeoutSeconds: props.idpSyncTimeoutSeconds,
      vpcConfig: props.vpcConfig,
    });
    this._cacheSync = new CacheSync(this, "CacheSync", {
      dynamoTable: this._dynamoTable,
      accessHandler: props.accessHandler,
      shouldRunAsCron: props.shouldRunCronHealthCheckCacheSync,
      identityGroupFilter: props.identityGroupFilter,
      vpcConfig: props.vpcConfig,
    });
    this._healthChecker = new HealthChecker(this, "HealthCheck", {
      dynamoTable: this._dynamoTable,
      shouldRunAsCron: props.shouldRunCronHealthCheckCacheSync,
      vpcConfig: props.vpcConfig,
    });
  }

  /**
   * if an arn is provided, a waf association will be created as part of the stack deployment for the root api
   * @param apiGatewayWafAclArn
   */
  private wafAssociation(apiGatewayWafAclArn: string) {
    if (apiGatewayWafAclArn != "") {
      const createApiGatewayWafAssociation = new CfnCondition(
        this,
        "CreateApiGatewayWafAssociationCondition",
        {
          expression: cdk.Fn.conditionNot(
            cdk.Fn.conditionEquals(apiGatewayWafAclArn, "")
          ),
        }
      );

      const apiGatewayWafAclAssociation = new CfnWebACLAssociation(
        this,
        "APIGatewayWebACLAssociation",
        {
          resourceArn: `arn:aws:apigateway:${
            Stack.of(this).region
          }::/restapis/${this._apigateway.restApiId}/stages/prod`,
          webAclArn: apiGatewayWafAclArn,
        }
      );
      apiGatewayWafAclAssociation.cfnOptions.condition =
        createApiGatewayWafAssociation;
    }
  }

  getRestApiURL(): string {
    return this._apigateway.url;
  }

  getWebhookApiURL(): string {
    // both prepend and append a / so we have to remove one out
    return (
      this._apigateway.url +
      this._webhook.path.substring(1, this._webhook.path.length)
    );
  }

  getDynamoTableName(): string {
    return this._dynamoTable.tableName;
  }
  getDynamoTable(): dynamodb.Table {
    return this._dynamoTable;
  }
  getWebhookLogGroupName(): string {
    return this._webhookLambda.logGroup.logGroupName;
  }
  getLogGroupName(): string {
    return this._lambda.logGroup.logGroupName;
  }
  getEventHandler(): EventHandler {
    return this._eventHandler;
  }
  getNotifiers(): Notifiers {
    return this._notifiers;
  }
  getIdpSync(): IdpSync {
    return this._idpSync;
  }
  getCacheSync(): CacheSync {
    return this._cacheSync;
  }
  getHealthChecker(): HealthChecker {
    return this._healthChecker;
  }

  getKmsKeyArn(): string {
    return this._KMSkey.keyArn;
  }
  getExecutionRoleArn(): string {
    return this._lambda.role?.roleArn || "";
  }
}
